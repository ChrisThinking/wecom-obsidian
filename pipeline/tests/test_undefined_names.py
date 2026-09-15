# -*- coding: utf-8 -*-
"""脚本「未定义名字」静态守护（重构后引用已移走变量的回归）。

复现过的问题：把下载/渲染循环从 `convert_toutiao.main()` 抽成 `render_body()`
之后，main 里仍引用 `n_img` / `fails`；因为成功标记先打印，现象是
「打印 CONVERT_URL_OK 之后立刻 NameError」。只测辅助函数的用例完全看不到它。

这里做一次保守的作用域分析：模块级 + 各函数自己的绑定（参数/赋值/import/
for/with/except/comprehension/global），`Load` 到的名字若哪一层都找不到、也不是
内置名，就判为未定义。覆盖全部 pipeline 脚本（含转换器入口与入口函数体），
比逐个入口造网络 fixture 更省也更广。
"""
import ast
import builtins
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _harness import REPO  # noqa: E402

BUILTINS = set(dir(builtins)) | {'__file__', '__name__', '__doc__', '__package__', '__spec__'}


class _Scope:
    def __init__(self, parent=None, names=None):
        self.names = set(names or ())
        self.parent = parent

    def has(self, name):
        scope = self
        while scope is not None:
            if name in scope.names:
                return True
            scope = scope.parent
        return False


class _Binder(ast.NodeVisitor):
    """收集绑定名；**不进入**嵌套函数/类体（它们的局部名对外不可见）。"""

    def __init__(self, names=None):
        self.names = names if names is not None else set()

    def visit_FunctionDef(self, node):
        self.names.add(node.name)

    def visit_AsyncFunctionDef(self, node):
        self.names.add(node.name)

    def visit_ClassDef(self, node):
        self.names.add(node.name)

    def visit_Lambda(self, node):
        return

    def visit_Global(self, node):
        self.names.update(node.names)

    def visit_Name(self, node):
        if not isinstance(node.ctx, ast.Load):
            self.names.add(node.id)

    def visit_arg(self, node):
        self.names.add(node.arg)

    def visit_Import(self, node):
        for alias in node.names:
            self.names.add((alias.asname or alias.name).split('.')[0])

    def visit_ImportFrom(self, node):
        for alias in node.names:
            self.names.add(alias.asname or alias.name)


def _Binder_names(tree):
    binder = _Binder()
    for stmt in tree.body:
        binder.visit(stmt)
    # 全局声明可能出现在函数内部：单独扫一遍
    for node in ast.walk(tree):
        if isinstance(node, ast.Global):
            binder.names.update(node.names)
    return binder.names


def _function_locals(node):
    """函数/类自身的局部绑定（参数 + 直接写在体内的绑定，不含嵌套函数）。"""
    binder = _Binder()
    args = getattr(node, 'args', None)
    if args is None:          # ClassDef 没有参数列表
        for stmt in node.body:
            binder.visit(stmt)
        return binder.names
    for arg in list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs):
        binder.names.add(arg.arg)
    if args.vararg:
        binder.names.add(args.vararg.arg)
    if args.kwarg:
        binder.names.add(args.kwarg.arg)
    for stmt in node.body:
        binder.visit(stmt)
    return binder.names


class UndefinedNameFinder(ast.NodeVisitor):
    """两段式：先收集各作用域的全部绑定，再检查 Load（与定义先后无关）。"""

    def __init__(self, tree):
        self.module = _Scope(names=_Binder_names(tree))
        self.scope = self.module
        self.undefined = []

    def _visit_function(self, node):
        outer = self.scope
        self.scope = _Scope(outer, _function_locals(node))
        for stmt in node.body:
            self.visit(stmt)
        self.scope = outer

    def visit_FunctionDef(self, node):
        self._visit_function(node)

    def visit_AsyncFunctionDef(self, node):
        self._visit_function(node)

    def visit_Lambda(self, node):
        args = node.args
        names = set()
        for arg in list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs):
            names.add(arg.arg)
        if args.vararg:
            names.add(args.vararg.arg)
        if args.kwarg:
            names.add(args.kwarg.arg)
        outer = self.scope
        self.scope = _Scope(outer, names)
        self.visit(node.body)
        self.scope = outer

    def visit_ClassDef(self, node):
        outer = self.scope
        self.scope = _Scope(outer, _function_locals(node))
        for stmt in node.body:
            self.visit(stmt)
        self.scope = outer

    def _comprehension_scope(self, generators, bodies):
        outer = self.scope
        self.scope = _Scope(outer)
        for gen in generators:
            self.visit(gen.iter)
            self._bind_target(gen.target)
            for cond in gen.ifs:
                self.visit(cond)
        for body in bodies:
            if body is not None:
                self.visit(body)
        self.scope = outer

    def visit_ListComp(self, node):
        self._comprehension_scope(node.generators, [node.elt])

    def visit_SetComp(self, node):
        self._comprehension_scope(node.generators, [node.elt])

    def visit_GeneratorExp(self, node):
        self._comprehension_scope(node.generators, [node.elt])

    def visit_DictComp(self, node):
        self._comprehension_scope(node.generators, [node.key, node.value])

    def _bind_target(self, target):
        if isinstance(target, ast.Name):
            self.scope.names.add(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._bind_target(elt)
        elif isinstance(target, ast.Starred):
            self._bind_target(target.value)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            if not self.scope.has(node.id) and node.id not in BUILTINS:
                self.undefined.append((node.lineno, node.id))
        else:
            self.scope.names.add(node.id)

    def visit_ExceptHandler(self, node):
        if node.type is not None:
            self.visit(node.type)
        if node.name:
            self.scope.names.add(node.name)
        for stmt in node.body:
            self.visit(stmt)


def undefined_names(path):
    """返回 `[(行号, 名字)]`（去重、按行号排序）。"""
    with open(path, encoding='utf-8') as handle:
        tree = ast.parse(handle.read(), filename=str(path))
    finder = UndefinedNameFinder(tree)
    finder.visit(tree)
    seen = {}
    for lineno, name in finder.undefined:
        seen.setdefault((lineno, name), True)
    return sorted(seen.keys())


def pipeline_scripts():
    out = []
    for root, dirs, files in os.walk(REPO / 'pipeline' / 'scripts'):
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for name in sorted(files):
            if name.endswith('.py'):
                out.append(os.path.join(root, name))
    return out


class UndefinedNameGuardTest(unittest.TestCase):
    def test_checker_would_catch_the_known_regression(self):
        """自证：把「main 引用 render_body 里的名字」写回临时文件必须被抓到。"""
        import tempfile
        src = (
            'def render_body():\n'
            '    n_img = 1\n'
            '    fails = []\n'
            '    return n_img, fails\n'
            '\n'
            'def main():\n'
            '    log("CONVERT_URL_OK")\n'
            '    print(n_img, len(fails))\n'
        )
        with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as fh:
            fh.write(src)
            path = fh.name
        try:
            found = [name for _line, name in undefined_names(path)]
            self.assertIn('n_img', found)
            self.assertIn('fails', found)
        finally:
            os.unlink(path)

    def test_no_undefined_names_in_pipeline_scripts(self):
        problems = []
        for path in pipeline_scripts():
            for lineno, name in undefined_names(path):
                problems.append('%s:%d 未定义名字 %r' % (os.path.relpath(path, REPO), lineno, name))
        self.assertEqual(problems, [], '发现未定义名字（重构后引用已移走的变量？）：\n' + '\n'.join(problems))


if __name__ == '__main__':
    unittest.main()
