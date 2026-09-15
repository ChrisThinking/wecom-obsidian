// 离线把一棵 CJS 依赖闭包扁平复制到目标 node_modules（源已是扁平布局）。
import fs from 'node:fs';
import path from 'node:path';

const [src, dst, ...roots] = process.argv.slice(2);
fs.mkdirSync(dst, { recursive: true });

const seen = new Set();
const queue = [...roots];
const copied = [];
const missing = [];

while (queue.length) {
  const name = queue.shift();
  if (!name || seen.has(name)) continue;
  seen.add(name);

  const from = path.join(src, name);
  if (!fs.existsSync(from)) { missing.push(name); continue; }
  const to = path.join(dst, name);
  if (!fs.existsSync(to)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, dereference: true });
    copied.push(name);
  }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8')); }
  catch { continue; }
  queue.push(...Object.keys(pkg.dependencies || {}));
  // optionalDependencies 里平台不匹配的会缺，属正常
}

console.log('copied  :', copied.join(', ') || '(none)');
console.log('missing :', missing.join(', ') || '(none)');
