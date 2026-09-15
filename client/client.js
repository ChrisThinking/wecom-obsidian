/**
 * dsh-wecom-obsidian —— Client 半边
 * ============================================================================
 * 设置页「企微 Obsidian 收藏」配置节。
 *
 * 通信完全走设置域现成的通道，不引入任何自定义 Remote：
 *
 *   读：`ctx.settingsScope.bind({ namespace }).getSnapshot()`
 *       —— 底层是设置域共享的 `settings.describe` 镜像，已做 `redactSecrets`。
 *   secret 状态：`ctx.settingsScope.describe().namespace(ns).secrets`
 *       —— `secret` 字段的**值**永远不会回到浏览器，只回一个 `{path, set}`，
 *          因此输入框按「只写」渲染：已设置就显示占位提示，留空即不修改。
 *   写：`scope.mutate([{op:'set', path:[...], value}], revision)`
 *       —— 路径寻址写入，因此不需要把整个配置（含 secret）回写一遍。
 *
 * 这个文件是 `window.__ModuleLoader__.load({id, factory})` 形式的客户端 bundle，
 * 与 DSH 自带客户端插件同构：工厂体内是惰性求值的，`require` 只解析
 * 平台 seed（react）与已注册的包工厂，因此除 react 外没有外部依赖。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wecom-obsidian',
  factory: (require) => {
    const React = require('react');

    const NS = 'wecom-obsidian';
    const e = React.createElement;
    const { useState, useMemo, useEffect, useCallback } = React;

    // ── 通用小工具 ──────────────────────────────────────────────────────────

    /** 稳定化一个对象引用，避免无意义的重渲染。 */
    const EMPTY = Object.freeze({});

    /**
     * 数据控制器：把 scope + describe 镜像合并成**一个**快照。
     *
     * 为什么不用 `useSyncExternalStore` 直连两个 store：
     *   1. 两个 store 各自变化会各自触发渲染，读数容易自相矛盾；
     *   2. `getSnapshot` 的引用稳定性是硬约束，派生值稍不注意就是无限重渲染；
     *   3. 一旦因此抛错，整个设置节会被替换成错误边界，**且没有任何提示**
     *      ——正是我们这次踩到的「静默显示 0」。
     *
     * 所以改成插件自己持有订阅：订阅在 `apply` 里建立一次，值变化时
     * 只做一次 `useState` 更新；组件只读一个普通对象。少一层契约，少一个
     * 静默失败点。另外把 `error` 也带上，页面就能把失败**显示出来**。
     *
     * @param {object} ctx - 客户端 Context（读 `ctx.remote.settings`、写同理）。
     * @returns {{subscribe: Function, read: Function}} 供 React 使用的极简接口。
     */
    function makeController(ctx) {
      const listeners = new Set();
      const remote = ctx.remote;
      let state = {
        status: 'loading',
        value: undefined,
        revision: undefined,
        writable: false,
        mode: 'remote',
        secrets: [],
        error: null,
        rawKeys: [],
      };

      /** 通知所有订阅者（单个出错不影响其它）。 */
      const emit = () => {
        for (const listener of listeners) {
          try { listener(); } catch { /* noop */ }
        }
      };

      /** 只在真的有变化时替换引用，避免无意义重渲染。 */
      const commit = (next) => {
        const changed = next.status !== state.status
          || next.value !== state.value
          || next.revision !== state.revision
          || next.writable !== state.writable
          || next.mode !== state.mode
          || next.secrets !== state.secrets
          || next.error !== state.error
          || next.rawKeys !== state.rawKeys;
        if (!changed) return;
        state = next;
        emit();
      };

      /**
       * 直接读 Remote：`ctx.remote.settings.describe()`
       *
       * 为什么不用 `ctx.settingsScope.bind(...)` 那一层：它是设置域给自家页面用的
       * 封装，契约会随版本变（本轮实测：`getSnapshot()` 返回的对象里没有 `status`
       * 字段）。而 `settings.describe` 是这个域**最底层、最稳定**的接口 ——
       * 设置页自己的镜像也是调它。少一层封装，就少一处「契约对不上但静默显示 0」。
       *
       * 读到的 view 已经是 `redactSecrets: true` 的结果：`secret` 字段被剥离，
       * 只在 `view.secrets` 里留下 `{path, set}` 槽位，所以浏览器永远拿不到密钥。
      */
      const refresh = () => {
        const settingsRemote = remote && remote.settings;
        if (!settingsRemote || typeof settingsRemote.describe !== 'function') {
          commit({
            status: 'unavailable',
            value: undefined,
            revision: undefined,
            writable: false,
            mode: 'remote',
            secrets: [],
            error: 'ctx.remote.settings 不可用',
            rawKeys: [],
          });
          return;
        }
        Promise.resolve()
          .then(() => settingsRemote.describe())
          .then((response) => {
            // 客户端 `ctx.remote.*` 的返回值是 **RemoteResult 信封**：
            //   { ok: true, value } | { ok: false, error: { message } }
            // 有些包装层会直接给裸值，所以两种形态都接受 —— 这里是本插件唯一的
            // 设置读取入口，它对形状的容忍度直接决定「页面是不是显示 0」。
            if (response && typeof response === 'object' && 'ok' in response) {
              if (response.ok !== true) {
                const message = response.error && response.error.message;
                throw new Error(message || 'settings.describe 返回失败');
              }
            }
            const answer = (response && typeof response === 'object' && 'ok' in response)
              ? response.value
              : response;
            const list = answer && Array.isArray(answer.namespaces) ? answer.namespaces : [];
            const entry = list.find((row) => row && row.ns === NS);
            if (entry === undefined) {
              // 宿主本进程里没有这个 namespace（插件没加载 / 版本不对）。
              commit({
                status: 'unavailable',
                value: undefined,
                revision: undefined,
                writable: !!(answer && answer.writable),
                mode: 'remote',
                secrets: [],
                error: `宿主未注册设置命名空间 ${NS}（收到 ${list.length} 个 namespace）`,
                rawKeys: [],
              });
              return;
            }
            commit({
              status: 'ready',
              value: entry.value,
              revision: entry.revision,
              writable: !!(answer && answer.writable),
              mode: 'remote',
              secrets: (entry.secrets) || [],
              error: null,
              rawKeys: entry && entry.value ? Object.keys(entry.value) : [],
            });
          })
          .catch((error) => {
            commit({
              ...state,
              status: state.value === undefined ? 'loading' : 'ready',
              error: String((error && error.message) || error),
            });
          });
      };

      // 首次读取 + 订阅两种失效信号：设置文档变更、连接重置。
      refresh();
      try {
        if (remote && typeof remote.$on === 'function') {
          remote.$on('settings/document-updated', () => refresh());
        }
      } catch { /* noop */ }
      try {
        if (ctx && typeof ctx.on === 'function') {
          ctx.on('connection/reset', () => refresh());
        }
      } catch { /* noop */ }

      return {
        subscribe(listener) {
          listeners.add(listener);
          refresh();
          return () => listeners.delete(listener);
        },
        read() {
          return state;
        },
      };
    }

    /**
     * 订阅控制器并返回当前状态。
     *
     * `subscribe` / `read` 都是控制器的稳定方法，因此 effect 只依赖控制器本身。
     */
    function useController(controller) {
      const [state, setState] = useState(() => controller.read());
      useEffect(() => controller.subscribe(() => setState(controller.read())), [controller]);
      return state;
    }


    const css = {
      page: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 2px 24px' },
      hint: { margin: '0', fontSize: '12px', lineHeight: '1.6', opacity: 0.72 },
      card: {
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.28))',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        background: 'var(--dsh-surface, transparent)',
      },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      botSummary: {
        display: 'grid',
        gridTemplateColumns: '48px minmax(160px, 1fr) auto 32px',
        alignItems: 'center',
        gap: '12px',
        minHeight: '38px',
      },
      botSummaryCell: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      expandButton: {
        width: '30px',
        height: '30px',
        padding: 0,
        borderRadius: '7px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '18px',
        lineHeight: 1,
      },
      botDetails: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        paddingTop: '12px',
        borderTop: '1px solid var(--dsh-border, rgba(127,127,127,0.22))',
      },
      cardTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px 14px' },
      field: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 },
      label: { fontSize: '12px', fontWeight: 500, opacity: 0.86 },
      desc: { fontSize: '11px', lineHeight: '1.5', opacity: 0.6 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 9px',
        fontSize: '13px',
        borderRadius: '7px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        background: 'var(--dsh-input-bg, transparent)',
        color: 'inherit',
        fontFamily: 'inherit',
      },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      button: {
        padding: '7px 14px',
        fontSize: '13px',
        borderRadius: '7px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        background: 'var(--dsh-button-bg, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      primary: {
        padding: '7px 16px',
        fontSize: '13px',
        fontWeight: 600,
        borderRadius: '7px',
        border: '1px solid var(--dsh-accent-border, rgba(64,128,255,0.5))',
        background: 'var(--dsh-accent-bg, rgba(64,128,255,0.14))',
        color: 'inherit',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      danger: {
        padding: '5px 10px',
        fontSize: '12px',
        borderRadius: '6px',
        border: '1px solid rgba(220,90,90,0.42)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      status: { fontSize: '12px', lineHeight: '1.6' },
      ok: { color: 'var(--dsh-success, #2f9e63)' },
      warn: { color: 'var(--dsh-warning, #c8871a)' },
      err: { color: 'var(--dsh-danger, #cf4b4b)' },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11.5px',
        padding: '1px 5px',
        borderRadius: '4px',
        background: 'rgba(127,127,127,0.14)',
      },
      toggle: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12.5px' },
      badge: {
        fontSize: '11px',
        padding: '2px 7px',
        borderRadius: '999px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        opacity: 0.85,
      },
    };

    /** 一个带标签与说明的输入行。 */
    function Field(props) {
      return e('label', { style: css.field },
        e('span', { style: css.label }, props.label),
        props.children,
        props.desc ? e('span', { style: css.desc }, props.desc) : null,
      );
    }

    /** 受控文本输入。 */
    function TextInput(props) {
      return e('input', {
        type: props.type || 'text',
        style: css.input,
        value: props.value == null ? '' : props.value,
        placeholder: props.placeholder || '',
        spellCheck: false,
        autoComplete: 'off',
        onChange: (event) => props.onChange(event.target.value),
      });
    }

    /** 数字输入：空串保留为空，便于「清空回落默认」。 */
    function NumberInput(props) {
      return e('input', {
        type: 'number',
        style: css.input,
        value: props.value == null ? '' : String(props.value),
        placeholder: props.placeholder || '',
        onChange: (event) => {
          const raw = event.target.value;
          if (raw === '') props.onChange('');
          else {
            const parsed = Number(raw);
            props.onChange(Number.isFinite(parsed) ? parsed : '');
          }
        },
      });
    }

    /** 布尔开关。 */
    function Toggle(props) {
      return e('label', { style: css.toggle },
        e('input', {
          type: 'checkbox',
          checked: !!props.checked,
          disabled: !!props.disabled,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        e('span', null, props.label),
      );
    }

    // ── 机器人配置草稿 ──────────────────────────────────────────────────────

    /**
     * 机器人名称 → 会话 id 用的稳定 slug。
     *
     * 会话 id 必须对同一台机器人长期稳定（否则每次改设置都会新建会话、丢掉
     * 上下文），所以从名称派生而不是随机生成。中文名会被压成空串，这时
     * 回落到序号（`bot2`），保证仍然唯一且稳定。
     *
     * @param {string} label - 机器人名称。
     * @param {number} index - 从 1 开始的序号。
     * @returns {string} 可用作会话 id 的片段。
     */
    /**
     * 判断 `{platform}` 是否写在 `{top}` 之前。
     *
     * 这种写法下顶层已经是平台目录，`{top}` 不再参与拼接 —— 是配置页最常见的
     * 误解，所以单独提示。解析实现在脚本侧（`wf.resolve_rel_dir`）。
     *
     * @param {string} pattern - 路径规则。
     * @returns {boolean} 是否需要提示。
     */
    function platformBeforeTop(pattern) {
      const p = String(pattern || '');
      const iPlatform = p.indexOf('{platform}');
      const iTop = p.indexOf('{top}');
      return iPlatform !== -1 && (iTop === -1 || iPlatform < iTop);
    }

    /**
     * 生成路径规则的示例，用于设置页即时预览。
     *
     * 与脚本侧 `wf.resolve_rel_dir` 保持同一套替换规则（这里是预览，不必
     * 完全复刻平台判别，用「微信」作平台样例即可）。
     *
     * @param {string} pattern - 路径规则。
     * @param {string} topFolder - 顶层目录名。
     * @returns {string} 示例相对路径。
     */
    function previewPath(pattern, topFolder) {
      const text = String(pattern || '{top}/{YYYY}/{MM}/{name}')
        .replace('{top}', String(topFolder || '01_文章分享'))
        .replace('{platform}', '微信')
        .replace('{YYYY}', '2026')
        .replace('{MM}', '09')
        .replace('{name}', '文章标题');
      return text.split('/').filter((seg) => seg !== '').join('/');
    }

    function slugOf(label, index) {
      const ascii = String(label || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
      return ascii || `bot${index}`;
    }

    /**
     * 一台机器人的默认配置：除名称/Bot ID/Secret 之外**全部自动推断**。
     *
     * 之所以把这些字段也写进配置（而不是留空在运行时兜底），是为了让
     * settings.yaml 自己就是一份完整、可读、可手改的真值 —— 配置页只编辑
     * 其中三项，其余保持原样。
     *
     * **展示编号与会话身份分开**：`label` 可以复用（删中间一台后补位），但会话 id
     * 带一次性随机后缀 —— 路由按 sessionId 恢复历史会话，复用旧 id 会让新机器人
     * 继承被删机器人的上下文（宿主侧 `lib/bot-ops.js` 是同一套规则）。
     *
     * @param {number} index - 从 1 开始的序号（仅用于展示名与可读前缀）。
     * @param {string} [token] - 身份后缀；不传则本地随机生成。
     * @returns {object} 完整 bot 配置。
     */
    function defaultBot(index, token) {
      const label = `机器人${index}`;
      const slug = slugOf(label, index);
      const id = String(token || Math.random().toString(36).slice(2, 8));
      return {
        label,
        enabled: true,
        botId: '',
        secret: '',
        sessionId: `wecom-${slug}-${id}`,
        collectorSessionId: `wecom-${slug}-${id}-collector`,
        collectEnabled: true,
        mediaEnabled: true,
        policy: 'open',
        allowlist: [],
        blockedReply: '该指令未对本机器人开放。',
        provider: '',
        model: '',
        reasoningEffort: 'high',
      };
    }

    /**
     * 把「配置页草稿」合并进「已保存的机器人配置」。
     *
     * 配置页只编辑三项（名称 / Bot ID / Secret），其余字段：
     *   · 已保存过 → **原样保留**（手改过 settings.yaml 的人不会被悄悄重置）；
     *   · 还没有   → 用 {@link defaultBot} 的自动推断值补齐。
     *
     * secret 是只写字段：草稿里为空表示「不修改」，因此要从结果里删掉 ——
     * 否则一次保存就会把宿主上已存的密钥抹掉。浏览器本来也从未见过它。
     *
     * 纯函数，便于单测（不依赖 React 与 Context）。
     *
     * @param {object|undefined} saved - 已保存的机器人配置（可能不存在 = 新增）。
     * @param {object} draft - 表单里的三项值。
     * @param {number} index - 从 1 开始的序号。
     * @returns {object} 要写入配置的完整机器人配置。
     */
    function mergeBotEdit(saved, draft, index) {
      const out = (saved && typeof saved === 'object') ? { ...saved } : defaultBot(index);

      // 没有对应草稿字段时必须保留 settings.yaml 中的已保存值。
      // `cardOf()` 会用空草稿构造纯展示卡片；此前这里无条件赋值，导致每次
      // 渲染都把真实名称改成“机器人1/2/3”，并把 Bot ID 显示成空串。
      if (Object.prototype.hasOwnProperty.call(draft, 'label')) {
        out.label = String(draft.label || '').trim() || `机器人${index}`;
      }
      if (Object.prototype.hasOwnProperty.call(draft, 'botId')) {
        out.botId = String(draft.botId || '').trim();
      }

      // 会话 id：缺失时按名称派生。稳定 —— 同一台机器人不会因为改名而换会话。
      const slug = slugOf(out.label, index);
      if (!out.sessionId) out.sessionId = `wecom-${slug}`;
      if (!out.collectorSessionId) out.collectorSessionId = `wecom-${slug}-collector`;

      delete out.secret;
      if (typeof draft.secret === 'string' && draft.secret.length > 0) out.secret = draft.secret;

      return out;
    }

    // ── 主组件 ──────────────────────────────────────────────────────────────

    /**
     * 设置节的普通依赖工厂。
     *
     * DSH 会把 `inject.hooks` 中的 external store 转换成 `useXxx` 属性；它不是
     * 一个会原样传给组件的 `props.hooks` 容器。这里的 scope 和 controller 都是
     * 普通对象，因此必须作为 inject 返回值的顶层属性传入组件。
     *
     * @param {object} ctx - 客户端插件 Context。
     * @returns {{wecomScope: object, wecomController: object}} 组件的普通 props。
     */
    function injectedFor(ctx) {
      // 写入用一个绑定作用域（它按路径寻址写、带 revision 栅栏，正好适合表单）。
      // **读取不用它** —— 见 makeController 里「为什么直接读 Remote」的说明。
      const bound = ctx.settingsScope.bind({ namespace: NS });

      return {
        // 组件里以 `props.wecomScope` 取用；写入走它的 mutate。
        wecomScope: bound,
        // 控制器在 apply 时建立一次并订阅；组件只读它。
        wecomController: makeController(ctx),
        writeSettings: async (ops, expectedRevision) => {
          const response = await ctx.remote.settings.mutate(NS, ops, expectedRevision);
          if (!response || response.ok !== true) {
            const message = response && response.error && response.error.message;
            throw new Error(message || '设置写入被宿主拒绝');
          }
          return response.value;
        },
      };
    }

    /** 设置节主体。 */
    function WecomObsidianSection(props) {
      const scope = props.wecomScope;
      const snapshot = props.wecomController ? useController(props.wecomController) : EMPTY;
      const secrets = useMemo(
        () => {
          const table = new Map();
          for (const slot of (snapshot.secrets || [])) {
            if (slot && Array.isArray(slot.path)) table.set(slot.path.join('.'), !!slot.set);
          }
          return table;
        },
        [snapshot.secrets],
      );

      const value = snapshot.value || EMPTY;
      const writable = snapshot.writable !== false && snapshot.mode !== 'memory';

      const valueBots = useMemo(
        () => {
          const overrides = value.botOverrides && typeof value.botOverrides === 'object'
            ? value.botOverrides
            : EMPTY;
          return (Array.isArray(value.bots) ? value.bots : []).map((bot, index) => ({
            ...(bot || {}),
            ...(overrides[String(index)] || {}),
          }));
        },
        [value],
      );
      const store = value.store || EMPTY;
      const pipeline = value.pipeline || EMPTY;

      // 机器人：每个卡片独立「保存应用」，所以本页只保存**未落盘的编辑**
      // （`botEdits[index]`），已保存的配置永远是 `valueBots` 本身。
      // 这样卡片上的「有未保存修改」是精确的，也不会因为别处刷新而丢掉编辑。
      const [botEdits, setBotEdits] = useState({});
      // 非机器人字段（路径规则/流水线）仍走原来的批式草稿 + 底部总保存。
      const [nonBot, setNonBot] = useState(null);
      const [message, setMessage] = useState(null);
      const [botMessage, setBotMessage] = useState(null);
      // 机器人默认只显示单行摘要；展开状态仅属于页面，不写入配置。
      const [expandedBots, setExpandedBots] = useState({});
      const [busy, setBusy] = useState(false);
      const [savingBot, setSavingBot] = useState(null);
      const revision = snapshot.revision;

      // 卡片草稿 = 已保存配置 + 该卡片的未落盘编辑。
      const cardOf = (index) => mergeBotEdit(valueBots[index], botEdits[index] || {}, index + 1);
      const isDirty = (index) => {
        const edit = botEdits[index];
        if (!edit) return false;
        return Object.keys(edit).length > 0;
      };

      const scalars = nonBot || {
        vaultRoot: value.vaultRoot || '',
        workspaceRoot: value.workspaceRoot || '',
        chatCwd: value.chatCwd || '',
        chatPreset: value.chatPreset || 'cordis',
        collectorCwd: value.collectorCwd || '',
        inboxDir: value.inboxDir || '{top}/attachments',
        replyAck: value.replyAck !== false,
        store: {
          folderPattern: store.folderPattern || '{top}/{YYYY}/{MM}/{name}',
          topFolder: store.topFolder || '01_文章分享',
          assetsDir: store.assetsDir || 'assets',
          conflictSuffix: store.conflictSuffix !== false,
        },
        pipeline: {
          markitdownCli: pipeline.markitdownCli || '',
          pythonBin: pipeline.pythonBin || '',
          convertTimeoutSec: pipeline.convertTimeoutSec == null ? 180 : pipeline.convertTimeoutSec,
          pipelineTimeoutSec: pipeline.pipelineTimeoutSec == null ? 600 : pipeline.pipelineTimeoutSec,
          mediaMaxMb: pipeline.mediaMaxMb == null ? 50 : pipeline.mediaMaxMb,
        },
      };

      /** 记录一张卡片上的未落盘编辑。 */
      const patchBot = useCallback((index, patch) => {
        setBotEdits((current) => ({ ...current, [index]: { ...(current[index] || {}), ...patch } }));
      }, []);

      /** 清掉一张卡片的未落盘编辑（放弃修改 / 保存成功 / 删除之后）。 */
      const clearBotEdit = useCallback((index) => {
        setBotEdits((current) => {
          if (!(index in current)) return current;
          const next = { ...current };
          delete next[index];
          return next;
        });
      }, []);

      /** 让控制器重新拉一次宿主状态（写入成功后同步，避免显示陈旧值）。 */
      const refreshNow = useCallback(() => {
        if (props.wecomController) props.wecomController.subscribe(() => {})();
      }, [props.wecomController]);

      /**
       * 保存并应用**单个**机器人。
       *
       * 用路径寻址写入（`bots/<index>`），而不是整段替换 `bots`：
       * 只会覆盖这一台，别的机器人与并发编辑都不会被牵连。
       */
      const saveBot = useCallback(async (index) => {
        const draft = botEdits[index] || {};
        const saved = valueBots[index];
        const hasSecret = typeof draft.secret === 'string' && draft.secret.length > 0;
        // 新增（还没有已保存配置）时，必须一次写全 3 项；编辑时只写改过的键。
        if (saved === undefined && (!draft.label || !draft.botId || !hasSecret)) {
          setBotMessage({ kind: 'err', text: `机器人${index + 1}：新增需要填「名称 / Bot ID / Secret」三项。` });
          return;
        }
        setSavingBot(index);
        setBotMessage(null);
        try {
          // 以已保存配置为基底算出完整配置，再只挑出被改动的键写回。
          const merged = mergeBotEdit(saved, draft, index + 1);
          const keys = saved === undefined
            ? Object.keys(merged)
            : Object.keys(draft);
          const ops = [];
          for (const key of keys) {
            if (key === 'secret' && !hasSecret) continue;
            ops.push({
              op: 'set',
              path: ['botOverrides', String(index), key],
              value: merged[key],
            });
          }
          await props.writeSettings(ops, revision);
          clearBotEdit(index);
          refreshNow();
          setBotMessage({ kind: 'ok', text: `「${merged.label}」已保存并应用（桥接会按新配置重连该机器人）。` });
        } catch (error) {
          setBotMessage({ kind: 'err', text: `保存失败：${String((error && error.message) || error)}` });
        } finally {
          setSavingBot(null);
        }
      }, [botEdits, valueBots, props.writeSettings, revision, props.wecomController, clearBotEdit, refreshNow]);

      /** 启用 / 停用一台机器人（立即写入并应用）。 */
      const toggleBotEnabled = useCallback(async (index, enabled) => {
        const saved = valueBots[index];
        if (saved === undefined) {
          // 新增但还没保存：只改草稿，等「保存应用」一起落盘。
          patchBot(index, { enabled });
          return;
        }
        setSavingBot(index);
        setBotMessage(null);
        try {
          await props.writeSettings([{
            op: 'set',
            path: ['botOverrides', String(index), 'enabled'],
            value: enabled,
          }], revision);
          refreshNow();
          setBotMessage({
            kind: 'ok',
            text: `「${saved.label || `机器人${index + 1}`}」已${enabled ? '启用' : '停用'}并应用。`,
          });
        } catch (error) {
          setBotMessage({ kind: 'err', text: `切换失败：${String((error && error.message) || error)}` });
        } finally {
          setSavingBot(null);
        }
      }, [valueBots, props.writeSettings, revision, props.wecomController, patchBot, refreshNow]);

      const patchScalar = useCallback((patch) => {
        setNonBot((current) => {
          const base = current || scalars;
          return { ...base, ...patch };
        });
      }, [scalars]);

      const patchNested = useCallback((group, patch) => {
        setNonBot((current) => {
          const base = current || scalars;
          return { ...base, [group]: { ...base[group], ...patch } };
        });
      }, [scalars]);

      /**
       * 追加一条机器人结构变更**意图**。
       *
       * 为什么不在这里直接改 `bots[]`：
       *   1. 浏览器读数已脱敏（`secret` 是 `role('secret')`，永不回传），用脱敏值
       *      整体写回会抹掉其余机器人的 Secret；
       *   2. DSH 的 path mutation 不能深入数组（`{path:['bots','0']}` 会把数组换成
       *      对象，随即被 schema 拒绝）。
       * 所以只提交 `{op, index, nonce}`，由宿主拿未脱敏的原始段执行并写回。
       *
       * @param {string} op - `add` / `remove`。
       * @param {number} index - `remove` 的目标下标（`add` 由宿主按当前长度决定）。
       * @returns {Promise<void>} 写入完成后 resolve。
       */
      const requestBotOp = useCallback(async (op, index) => {
        const queued = Array.isArray(value && value.botOps) ? value.botOps : [];
        const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await props.wecomScope.mutate([
          { op: 'set', path: ['botOps'], value: [...queued, { op, index, nonce }] },
        ]);
      }, [value, props.wecomScope]);

      /**
       * 新增一台机器人：向宿主提交一条意图，宿主追加带默认值的新机器人。
       *
       * 不在浏览器里拼默认值：新机器人的**编号**由宿主按「最小空闲序号」决定
       * （删除中间一台后补位，避免与既有机器人重名、会话 id 撞车）。
       */
      const addBot = useCallback(async () => {
        setSavingBot(valueBots.length);
        setBotMessage(null);
        try {
          await requestBotOp('add', -1);
          refreshNow();
          setBotMessage({ kind: 'ok', text: '已新增一台机器人：填好「名称 / Bot ID / Secret」后点该卡片的「保存应用」。' });
        } catch (error) {
          setBotMessage({ kind: 'err', text: `新增失败：${String((error && error.message) || error)}` });
        } finally {
          setSavingBot(null);
        }
      }, [valueBots.length, requestBotOp, refreshNow]);

      /**
       * 删除一台机器人：同样只提交意图。
       *
       * 结构变更（缩短 `bots[]` + 重排 `botOverrides[]` 下标）必须由宿主在未脱敏
       * 数据上完成 —— 浏览器侧无论怎么写都会丢掉其余机器人的 Secret。
       */
      const removeBot = useCallback(async (index) => {
        setSavingBot(index);
        setBotMessage(null);
        try {
          await requestBotOp('remove', index);
          // 结构变了，下标会重排，各卡片的未落盘编辑不能再跟着旧下标走。
          setBotEdits({});
          refreshNow();
          setBotMessage({ kind: 'ok', text: '已删除并应用。' });
        } catch (error) {
          setBotMessage({ kind: 'err', text: `删除失败：${String((error && error.message) || error)}` });
        } finally {
          setSavingBot(null);
        }
      }, [requestBotOp, refreshNow]);

      /**
       * 保存「路径规则 / 流水线」这一组标量设置。
       *
       * 机器人不在这里：每张卡片有各自的「保存应用」，改完即刻生效。
       */
      const save = useCallback(async () => {
        setBusy(true);
        setMessage(null);
        try {
          const ops = [
            { op: 'set', path: ['vaultRoot'], value: scalars.vaultRoot },
            // 媒体收件目录（库内路径）由本页维护。
            { op: 'set', path: ['inboxDir'], value: scalars.inboxDir || '{top}/attachments' },
            // 注意：**不写** workspaceRoot / chatCwd / chatPreset / collectorCwd。
            // 这四项已从配置页移除（自动推断或保持现值）；本页不碰它们，
            // 手改过 settings.yaml 的值因此不会被一次「保存」冲掉。
            { op: 'set', path: ['replyAck'], value: !!scalars.replyAck },
            { op: 'set', path: ['store'], value: { ...scalars.store } },
            { op: 'set', path: ['pipeline'], value: { ...scalars.pipeline } },
          ];
          await props.wecomScope.mutate(ops);
          setNonBot(null);
          setMessage({ kind: 'ok', text: '已保存。桥接插件会按新配置重建采集工作区。' });
        } catch (error) {
          setMessage({ kind: 'err', text: `保存失败：${String((error && error.message) || error)}` });
        } finally {
          setBusy(false);
        }
      }, [scalars, props.wecomScope]);

      if (snapshot.status === 'unavailable') {
        return e('div', { style: css.page },
          e('p', { style: css.hint },
            `设置命名空间 ${NS} 当前不可用：这个页面不是从回环地址打开的，偏好只存在于本浏览器进程内。`),
        );
      }

      // 读取状态必须**可见**：早先读取失败时页面静默显示「机器人（0）」，
      // 与「真的没配机器人」无法区分，排查只能靠猜。
      //
      // 这一行同时是**现场诊断**：直接把 scope/镜像的原始形状与读取异常摊开，
      // 因为宿主契约一旦对不上，症状就是「页面显示 0」而没有别处可看。
      const rawShape = useMemo(() => {
        const out = [];
        out.push(`scope=${scope === undefined ? 'undefined' : typeof scope}`);
        if (scope && typeof scope === 'object') {
          const keys = Object.keys(scope);
          out.push(`scope键=[${keys.slice(0, 12).join(',')}]`);
          out.push(`getSnapshot=${typeof scope.getSnapshot}`);
          out.push(`subscribe=${typeof scope.subscribe}`);
        }
        try {
          const raw = scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : undefined;
          if (raw && typeof raw === 'object') {
            out.push(`status=${JSON.stringify(raw.status)}`);
            out.push(`value=${raw.value === undefined ? 'undefined' : typeof raw.value}`);
          } else {
            out.push(`getSnapshot()=${raw === undefined ? 'undefined' : typeof raw}`);
          }
        } catch (error) {
          out.push(`getSnapshot抛错：${String((error && error.message) || error)}`);
        }
        out.push(`已读到值=${value === EMPTY ? '否' : '是'}`);
        out.push(`secret槽位=${(snapshot.secrets || []).length}`);
        if (snapshot.error) out.push(`镜像错误：${snapshot.error}`);
        return out.join(' · ');
      }, [scope, snapshot, value]);

      const statusLine = snapshot.status === 'loading'
        ? `正在从宿主读取设置…（${rawShape}）`
        : snapshot.status === 'ready'
          ? `已读取（mode=${snapshot.mode || '?'}, revision=${snapshot.revision ?? '-'}）`
          : `读取异常：status=${String(snapshot.status)}（${rawShape}）`;
      const missingValue = snapshot.status === 'ready' && value === EMPTY;

      return e('div', { style: css.page },

        e('p', { style: css.hint },
          '这里配置企业微信机器人与 Obsidian 收藏链路。保存后会写入 DSH 设置文档；'
          + '桥接插件订阅该配置并自动重连机器人、重建采集工作区。',
          e('br'),
          '凭证只存在本机设置文件里（0600），且 Secret 是「只写」字段：保存后不会再回传到浏览器。'),

        e('div', {
          style: {
            ...css.status,
            ...(snapshot.status === 'ready' ? css.ok : css.warn),
            padding: '7px 10px',
            borderRadius: '7px',
            border: '1px solid var(--dsh-border, rgba(127,127,127,0.28))',
          },
        }, statusLine),

        missingValue
          ? e('p', { style: { ...css.hint, ...css.err } },
            '宿主已登记该 namespace，但浏览器没有拿到配置值。'
            + '这通常意味着设置页缓存了旧版插件 bundle —— 请硬刷新（Cmd/Ctrl+Shift+R）。')
          : null,

        // ── 机器人列表 ─────────────────────────────────────────────────────
        e('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          e('div', { style: css.cardHead },
            e('h3', { style: css.cardTitle }, `企业微信机器人（${valueBots.length}）`),
            e('span', { style: css.desc },
              valueBots.length === 0
                ? '尚未配置'
                : `${valueBots.filter((b) => b && b.enabled !== false).length} 台已启用 · 每张卡片改完点「保存应用」立即生效`),
            e('button', { style: css.button, disabled: !writable, onClick: () => { void addBot(); } }, '+ 添加机器人'),
          ),

          valueBots.length === 0
            ? e('p', { style: css.hint }, '还没有配置机器人。点「添加机器人」填入「机器人名称 / Bot ID / Secret」即可启用。')
            : null,

          botMessage
            ? e('div', { style: { ...css.status, ...(botMessage.kind === 'ok' ? css.ok : css.err) } }, botMessage.text)
            : null,

          valueBots.map((saved, index) => {
            const bot = cardOf(index);
            const secretSet = secrets.get(`bots.${index}.secret`) === true
              || secrets.get(`botOverrides.${index}.secret`) === true
              || (typeof saved.secret === 'string' && saved.secret.length > 0);
            const dirty = isDirty(index);
            const working = savingBot === index;
            const expanded = expandedBots[index] === true;
            return e('div', { key: `bot-${index}`, style: css.card },
              // 默认单行摘要：列表编号、名称、启停开关和展开箭头。
              // 企微 Bot ID 属于完整信息，只在展开后显示。
              e('div', { style: css.botSummary },
                e('div', { style: { ...css.botSummaryCell, textAlign: 'center' }, title: `机器人编号 ${index + 1}` },
                  e('span', { style: { ...css.badge, fontWeight: 600 } }, String(index + 1)),
                ),
                e('div', { style: css.botSummaryCell, title: bot.label || `机器人${index + 1}` },
                  e('span', { style: css.label }, bot.label || `机器人${index + 1}`),
                  dirty ? e('span', { style: { ...css.badge, ...css.warn, marginLeft: '8px' } }, '有未保存修改') : null,
                ),
                // 启用 / 停用：立即写入并应用，不需要展开或再次保存。
                e(Toggle, {
                  checked: bot.enabled !== false,
                  disabled: !writable || working,
                  label: bot.enabled !== false ? '已启用' : '已停用',
                  onChange: (checked) => { void toggleBotEnabled(index, checked); },
                }),
                e('button', {
                  type: 'button',
                  style: css.expandButton,
                  'aria-label': expanded ? `收起${bot.label || `机器人${index + 1}`}详情` : `展开${bot.label || `机器人${index + 1}`}详情`,
                  'aria-expanded': expanded,
                  title: expanded ? '收起完整信息' : '展开完整信息',
                  onClick: () => setExpandedBots((current) => ({ ...current, [index]: !expanded })),
                }, expanded ? '⌃' : '⌄'),
              ),

              expanded ? e('div', { style: css.botDetails },
                e('div', { style: css.cardHead },
                  e('h4', { style: css.cardTitle }, '机器人完整信息与功能'),
                  e('button', { style: css.danger, disabled: !writable || working, onClick: () => { void removeBot(index); } }, '删除机器人'),
                ),

                // 只保留三项「必须由人提供」的信息，其余全部自动推断：
              //   会话 id   → 按机器人名称派生（见 defaultBot）
              //   能力开关   → 收藏 / 媒体全开
              //   模型路由   → 跟随 DSH 部署默认（agent-default-model）
              // 已保存过的值不会被覆盖 —— 保存时以已保存配置为基底合并这三项。
                e('div', { style: css.grid },
                e(Field, { label: '机器人名称' },
                  e(TextInput, {
                    value: bot.label,
                    placeholder: '例如：我的机器人',
                    onChange: (text) => patchBot(index, { label: text }),
                  }),
                  e('span', { style: css.desc }, '用于日志、健康状态与会话 id 派生，可自由命名。'),
                ),
                e(Field, { label: 'Bot ID' },
                  e(TextInput, {
                    value: bot.botId,
                    placeholder: '企微智能机器人 Bot ID',
                    onChange: (text) => patchBot(index, { botId: text }),
                  }),
                ),
                e(Field, {
                  label: 'Secret',
                  desc: secretSet ? '已设置。留空表示不修改。' : '尚未设置，请填入企微后台的 Secret。',
                },
                  e(TextInput, {
                    type: 'password',
                    value: bot.secret,
                    placeholder: secretSet ? '••••••••（已保存，留空不修改）' : '企微智能机器人 Secret',
                    onChange: (text) => patchBot(index, { secret: text }),
                  }),
                ),
                ),

                e('div', { style: css.actions },
                e('button', {
                  style: css.primary,
                  disabled: !writable || working || !dirty,
                  onClick: () => { void saveBot(index); },
                }, working ? '应用中…' : (dirty ? '保存应用' : '已是最新')),
                e('button', {
                  style: css.button,
                  disabled: working || !dirty,
                  onClick: () => clearBotEdit(index),
                }, '放弃修改'),
                e('span', { style: css.desc },
                  '其余参数自动推断：收藏与媒体全开 · 会话 id 按名称派生 · 模型跟随 DSH 部署默认。'),
                ),
              ) : null,
            );
          }),
        ),

        // ── Obsidian 与存储路径 ────────────────────────────────────────────
        e('div', { style: css.card },
          e('h3', { style: css.cardTitle }, 'Obsidian 导入位置与收藏路径规则'),
          // 字段顺序 = 用户使用时的思考顺序：先「库在哪」，再「库内怎么分」，
          // 然后「图片放哪」「其它文件收哪」。
          e('div', { style: css.grid },
            e(Field, {
              label: 'Obsidian 导入地址（库根目录）',
              desc: '笔记最终写入的 Obsidian Vault 绝对路径，例如 /path/to/YourVault。',
            },
              e(TextInput, {
                value: scalars.vaultRoot,
                placeholder: '/path/to/ObsidianVault',
                onChange: (text) => patchScalar({ vaultRoot: text }),
              }),
            ),
            e(Field, {
              label: '顶层目录名',
              desc: '库内一级目录，即规则里 {top} 的取值。单层目录名。',
            },
              e(TextInput, {
                value: scalars.store.topFolder,
                placeholder: '01_文章分享',
                onChange: (text) => patchNested('store', { topFolder: text }),
              }),
            ),
            e(Field, {
              label: '收藏途径规则',
              desc: '入库时的目录结构。支持 {top} 顶层目录、{YYYY} 年、{MM} 月、'
                + '{platform} 平台、{name} 笔记名。默认「年/月」。',
            },
              e(TextInput, {
                value: scalars.store.folderPattern,
                placeholder: '{top}/{YYYY}/{MM}/{name}',
                onChange: (text) => patchNested('store', { folderPattern: text }),
              }),
            ),
            e(Field, {
              label: '文章图片路径名',
              desc: '每篇笔记随包的图片目录名。单层目录名。',
            },
              e(TextInput, {
                value: scalars.store.assetsDir,
                placeholder: 'assets',
                onChange: (text) => patchNested('store', { assetsDir: text }),
              }),
            ),
            e(Field, {
              label: '其他文件收件目录',
              desc: '企微发来的图片/文件落盘位置。默认 `<库根>/<顶层目录>/attachments`，'
                + '即文件与笔记同在 Obsidian 库内。占位符：{top} 收藏主目录 · {vault} 库根 · '
                + '{workspace} 插件工作区；相对路径按库根解析。',
            },
              e(TextInput, {
                value: scalars.inboxDir,
                placeholder: '{top}/attachments',
                onChange: (text) => patchScalar({ inboxDir: text }),
              }),
            ),
          ),
          // 下面这些字段已按「自动推断」处理，不再让用户填，
          // 但它们仍留在设置文档里，需要时可直接编辑：
          //   workspaceRoot  —— 采集工作目录（脚本与中间产物，改它等于搬家）
          //   chatCwd        —— 对话工作目录（同采集工作目录）
          //   chatPreset     —— 对话 Agent 预设（cordis）
          e('p', { style: css.desc },
            '已自动处理、无需配置：采集工作目录（${DSH_HOME}/wecom-obsidian/workspace）· '
            + '对话工作目录 · 对话 Agent 预设。'
            + '如需改动，直接编辑设置文档里的对应字段（本页保存时**不会**覆盖它们）。'),
          e('div', { style: css.actions },
            e(Toggle, {
              checked: scalars.store.conflictSuffix,
              label: '同名冲突自动加 -2/-3 后缀',
              onChange: (checked) => patchNested('store', { conflictSuffix: checked }),
            }),
            e(Toggle, {
              checked: scalars.replyAck,
              label: '收到消息先回执',
              onChange: (checked) => patchScalar({ replyAck: checked }),
            }),
          ),
          e('p', { style: css.hint },
            '当前规则解析为：', e('code', { style: css.code }, scalars.store.folderPattern),
            ' → 例：', e('code', { style: css.code },
              previewPath(scalars.store.folderPattern, scalars.store.topFolder)),
          ),
          // {platform} 写在 {top} 之前时，顶层已是平台目录，{top} 不参与拼接。
          // 这是容易踩的坑，就地提示，而不是让人事后发现目录不对。
          platformBeforeTop(scalars.store.folderPattern)
            ? e('p', { style: { ...css.desc, ...css.warn } },
              `注意：{platform} 出现在 {top} 之前 → 顶层直接就是平台目录，`
              + `「顶层目录名」（${scalars.store.topFolder}）不会参与拼接。`
              + '若想保留顶层目录，请写成 {top}/{platform}/…。')
            : null,
        ),

        // ── 流水线参数 ─────────────────────────────────────────────────────
        e('div', { style: css.card },
          e('h3', { style: css.cardTitle }, '采集流水线'),
          e('div', { style: css.grid },
            e(Field, { label: 'markitdown CLI 路径', desc: '通用网页转换器依赖；留空从 PATH 查找。' },
              e(TextInput, {
                value: scalars.pipeline.markitdownCli,
                placeholder: '（默认：PATH 中的 markitdown）',
                onChange: (text) => patchNested('pipeline', { markitdownCli: text }),
              }),
            ),
            e(Field, { label: 'Python 解释器', desc: '留空使用 python3。' },
              e(TextInput, {
                value: scalars.pipeline.pythonBin,
                placeholder: 'python3',
                onChange: (text) => patchNested('pipeline', { pythonBin: text }),
              }),
            ),
            e(Field, { label: '单篇转换超时（秒）' },
              e(NumberInput, {
                value: scalars.pipeline.convertTimeoutSec,
                onChange: (value) => patchNested('pipeline', { convertTimeoutSec: value === '' ? '' : value }),
              }),
            ),
            e(Field, { label: '整链处理超时（秒）' },
              e(NumberInput, {
                value: scalars.pipeline.pipelineTimeoutSec,
                onChange: (value) => patchNested('pipeline', { pipelineTimeoutSec: value === '' ? '' : value }),
              }),
            ),
            e(Field, { label: '媒体大小上限（MB）' },
              e(NumberInput, {
                value: scalars.pipeline.mediaMaxMb,
                onChange: (value) => patchNested('pipeline', { mediaMaxMb: value === '' ? '' : value }),
              }),
            ),
          ),
        ),

        // ── 保存 ───────────────────────────────────────────────────────────
        e('div', { style: css.actions },
          e('button', {
            style: css.primary,
            disabled: !writable || busy,
            onClick: () => { void save(); },
          }, busy ? '保存中…' : '保存路径规则'),
          e('button', {
            style: css.button,
            disabled: busy,
            onClick: () => { setNonBot(null); setMessage(null); },
          }, '放弃修改'),
          e('span', { style: css.desc }, '（只作用于上方路径规则与流水线；机器人各自有「保存应用」。）'),
          message
            ? e('span', { style: { ...css.status, ...(message.kind === 'ok' ? css.ok : css.err) } }, message.text)
            : null,
        ),

        e('p', { style: css.hint },
          '配置文件：', e('code', { style: css.code }, '${DSH_HOME}/settings.yaml'),
          '  ·  运行时数据：', e('code', { style: css.code }, '${DSH_HOME}/wecom-obsidian/'),
          '  ·  收藏预设：', e('code', { style: css.code }, 'wecom-obsidian-collector'),
        ),
      );
    }

    // ── 插件体 ──────────────────────────────────────────────────────────────

    /** 需要的客户端服务。 */
    const inject = ['slots', 'settingsScope', 'remote', 'remote.settings'];

    /**
     * @param {object} ctx - 客户端 Context。
     */
    function apply(ctx) {
      const injected = injectedFor(ctx);
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'wecom-obsidian',
        order: 40,
        label: () => '企微 Obsidian 收藏',

        inject: () => injected,
      }, WecomObsidianSection));
    }

    // 测试接缝：把纯函数挂到 globalThis，供 `tests/unit.test.mjs` 断言。
    // 不参与运行时逻辑，仅为「让静默出错的函数能被测试盯住」而存在
    // （覆盖表错位、路径解析这类问题不会抛错，只会写错位置）。
    try {
      globalThis.__wecomObsidianInternals = { mergeBotEdit, defaultBot };
    } catch { /* 无 globalThis 的环境跳过 */ }

    return { apply, inject };
  },
});
