# AI 出口目标解析下沉到服务端

日期：2026-07-17

## 背景

`verge-extension`（Chrome 扩展）已修复「填了 AI 规则却没指定出口目标时，规则被静默丢弃」的问题：引入 `resolveAITarget()` 回退链（手填 → AI 总出口组 → 直连住宅 → 住宅节点 → 报错），复选框默认勾选，校验方向反转。详见 `verge-extension/docs/superpowers/specs/2026-07-17-ai-exit-fallback-design.md`。

`verge-plugin` 与 `verge-extension` **共用同一个 `core` submodule**（`https://github.com/jcoder-stack/verge-core.git`）。`verge-plugin/src/server.js:17` 通过 `express.static` 直接托管 `core/web`，即两者跑的是同一份 `index.html` + `app.js`。

## 问题

### 1. `verge-plugin` 在 HEAD 状态下无法运行

`.gitmodules` 声明了 `core` submodule，但**提交树中没有对应的 gitlink**（`git ls-tree HEAD core` 为空，`git ls-files` 中无 `core` 条目），磁盘上也没有 `core/` 目录。`src/routes/api.js:6` 的 `require("../../core")` 直接抛 MODULE_NOT_FOUND。

因为缺的是 gitlink 而非仅仅未初始化，`git submodule update --init` 无法修复——git 不知道该检出哪个 commit。

### 2. 回退链在 `verge-plugin` 中失效

修复后的 `core/web/app.js` 这样取回退链：

```js
const resolveTarget = window.VergeTransport && window.VergeTransport.resolveAITarget;
const aiTargetFinal = resolveTarget
  ? resolveTarget({ ... })
  : (aiTarget || aiExitGroup);
```

`verge-extension` 经 esbuild 把 `core/lib/ai-target.js` 打进 `transport.js` 并挂到 `window.VergeTransport.resolveAITarget`（`src/transport-ext.js`）。

`verge-plugin` 则有自己手写的一份 `src/web-overlay/transport.js`，只暴露 `supportsHook / apiFetch / apiParse / apiGenerate`，**没有 `resolveAITarget`**。于是 `app.js` 落入 `: (aiTarget || aiExitGroup)` 分支——正是修复前的原表达式。

实际后果：静默丢弃已被新校验拦住（会报错），但**回退链不生效**——用户取消勾选总出口组且不填出口目标时会直接报错，而非优雅回退到「直连住宅」。

根因：`verge-plugin` 没有打包器（依赖仅 express + js-yaml），而 `core/lib/ai-target.js` 是 CommonJS 模块，浏览器无法用 `<script>` 直接加载。

## 设计

**把出口目标解析从浏览器侧下沉到生成入口（服务端/本地生成函数）。**

`verge-plugin/src/routes/api.js` 与 `verge-extension/src/transport-ext.js` 的 `localGenerate()` 是近乎逐行的孪生实现，两者在分发给生成器之前都已算出 `residentialGroup` / `directResidentialGroup` / `aiExitGroup` / `aiExitMembers`——**回退链所需的全部入参它们本来就有**，无需新增任何请求字段。

这样彻底绕开「浏览器加载 CommonJS 模块」的问题：解析发生在两个宿主都已具备 `require` 能力的位置。

### 1. `core/lib/ai-target.js` 新增 `resolveAIRules()`

保留现有纯函数 `resolveAITarget()` 不动（已有 13 个单测覆盖），在其上新增一层供生成入口调用：

```js
resolveAIRules({ aiRules, aiExitGroup, residentialGroup, directResidentialGroup, residentials, directResidentials })
  → { ...aiRules, target } | null
  → 无可用出口目标时抛 Error（带 .status = 400）
```

行为：

- `aiRules` 为空、或其 `domains`/`providers` 均为空 → 返回 `null`（用户没填规则，正常）
- 否则调 `resolveAITarget()` 求出 target
- target 为 `null` → 抛错（有规则却无处可去）
- 否则返回 target 已填好的新 `aiRules`

`hasResidentials` / `hasDirectResidentials` 用 `.some(r => r && r.name)` 判定，与 `core/lib/generate-yaml.js:63-66` 的 `aiExitMembers` 判定一致。这顺带消除了原方案中 `app.js` 用 `length > 0`、生成器用 `.some(...)` 的判定不对称。

**错误类型用带 `.status` 的普通 `Error`，不引入 `HttpError`。** 理由：`api.js:169` 已有 `res.status(e.status || 500)`，`transport-ext.js` 也已 `catch` 后重抛——两边都能直接消费，且 `ai-target.js` 得以保持不依赖 `generate-yaml.js`（后者会传递性引入 js-yaml）。

### 2. 两个生成入口接入

`verge-plugin/src/routes/api.js` 与 `verge-extension/src/transport-ext.js` 各自在算出 `aiExitGroup` 之后、**完整性校验之前**调用 `resolveAIRules()`，后续一律使用其返回值而非原始 `aiRules`。

顺序很关键：解析必须早于完整性校验（`api.js:118` / `transport-ext.js:105`），这样被校验的是**已解析的** target，而不是可能为空的原始值。这实际上收紧了校验——回退链选出的组名也会被完整性校验兜一道。

### 3. `core/web/app.js` 简化

删除：

- `resolveTarget` 的取用与调用（连同 `: (aiTarget || aiExitGroup)` 兜底整块）
- 客户端的「填写了 AI 规则，但没有任何可用的出口目标」校验

改为直接组装并原样发送：

```js
const aiRules = hasAIRules ? { target: aiTarget, domains: aiDomains, providers: aiProviders } : null;
```

`target` 允许为空字符串——由服务端解析。`aiExitGroup` 仍按原样发送（未启用时为 `""`）。

错误改由服务端返回：`app.js` 既有的 `apiGenerate` 调用会抛出并展示服务端错误信息，无需客户端重复实现这条判断。

副作用：`app.js` 不再依赖 `window.VergeTransport.resolveAITarget`，两个宿主的 transport 契约重新对齐。

### 4. `verge-extension/src/transport-ext.js` 清理

`window.VergeTransport` 与 Node 侧 `ext` 导出中的 `resolveAITarget` 挂载可以移除——`app.js` 不再需要它，且它本就是为绕开打包限制而加的。`localGenerate` 改为在内部调用 `resolveAIRules()`。

### 5. `verge-plugin` 补回 core gitlink

`.gitmodules` 已声明 `core`，故不能用 `git submodule add`（会报已存在）。做法：把 `verge-core.git` 克隆到 `core/`，检出目标 commit，再 `git add core`——git 检测到 `core/.git` 存在时会自动创建 gitlink。

指针指向本次改动后的 core 最新 commit。

## 数据流（改动后）

```
用户输入
  → core/web/app.js 读 DOM，原样发送 { aiRules:{target(可空), domains, providers}, aiExitGroup, ... }
  → 生成入口（二选一）:
      verge-extension: src/transport-ext.js localGenerate()
      verge-plugin:    src/routes/api.js   POST /api/generate
    ├─ resolveAIRules()  ← 回退链在此解析；无出口可用则抛 400
    ├─ 目标引用完整性校验（校验的是已解析的 target）
    ├─ 死循环防御
    └─ core/lib/generate-yaml.js  或  core/lib/generate-script.js
```

## 顺带修掉的既有问题

本设计一并消除 `verge-extension` 最终整分支审查遗留的三个 Minor：

| 原 Minor | 如何消除 |
| --- | --- |
| `app.js` 报错顺序：AI 校验抢在「至少要有一个出口来源」之前 | 客户端 AI 校验整块删除，出口来源校验自然先触发 |
| `app.js` 的 `: (aiTarget \|\| aiExitGroup)` 死代码兜底 | 整块删除 |
| `app.js` 用 `length > 0` 与 `generate-yaml.js` 的 `.some(r => r && r.name)` 判定不对称 | 判定收归 `resolveAIRules()` 一处，统一用 `.some(...)` |

## 测试

**`core/test/ai-target.test.js`**（补充，现有 13 例不动）：

- `aiRules` 为 `null` → 返回 `null`
- `aiRules.domains` 与 `providers` 均为空 → 返回 `null`
- `aiRules.target` 已填 → 原样返回该 target
- `target` 空 + 启用总出口组 + 有直连 → target 为总出口组名
- `target` 空 + 未启用总出口组 + 仅有直连 → target 为直连住宅组名
- `target` 空 + 未启用总出口组 + 仅有中转 → target 为住宅节点组名
- `target` 空 + 无任何住宅 → 抛错，且 `.status === 400`
- `directResidentials` 含无 `name` 的条目 → 不计入成员（验证判定与生成器一致）

**`verge-extension/test/transport-ext.test.js`**（改写原有的 `resolveAITarget` 导出断言）：

- `localGenerate` 收到 `aiRules.target` 为空 + 有直连住宅 → 产出的 YAML 中 AI 规则指向直连住宅组

**`verge-plugin/test/generate.test.js`**（补充）：

- `POST /api/generate`，`aiRules.target` 为空 + 有直连住宅 → 200，YAML 中 AI 规则指向直连住宅组
- `POST /api/generate`，有 AI 规则 + 无任何住宅 → 400，错误信息含「没有任何可用的出口目标」

## 实施注意

改动跨三个仓库，提交顺序有依赖：

1. **core**：新增 `resolveAIRules()`、简化 `app.js`；提交并推送（两个宿主都要拉到它）
2. **verge-extension**：`transport-ext.js` 接入 + 清理挂载；bump submodule 指针
3. **verge-plugin**：`api.js` 接入；补 core gitlink

`verge-plugin/CLAUDE.md` 约定：提交信息用 Conventional Commits，**不加 `Co-Authored-By`**，且不得出现 Claude 相关字样。该约定仅适用于 `verge-plugin` 仓库。

`verge-extension` 已发布 0.1.1（含旧方案）。本次改动后需重新打包发布 0.1.2——0.1.1 在 `verge-plugin` 场景下回退链不生效，但在扩展自身场景下功能正确，故非紧急撤回。

## 不做的事

- 不改动 `core/lib/generate-yaml.js`、`core/lib/generate-script.js` 的规则注入逻辑
- 不改动 `resolveAITarget()` 纯函数本身及其 13 个现有单测
- 不给 `verge-plugin` 引入打包器
- 不合并 `api.js` 与 `localGenerate` 这两份孪生实现（诱人，但超出本次范围）
