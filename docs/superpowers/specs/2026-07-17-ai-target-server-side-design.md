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

### 0. 前置修正：AI 规则无目标时不得阻断生成

**用户实测发现的回归（本设计的直接触发因素）。**

`verge-extension` 0.1.1 中 `core/web/app.js:378` 有：

```js
const hasAIRules = aiDomains.length > 0 || aiProviders.length > 0;
if (hasAIRules && !aiTargetFinal) {
  return { error: "填写了 AI 规则，但没有任何可用的出口目标：请在「2.5 直连住宅订阅」勾选直连节点，或在上方添加中转住宅，再生成。" };
}
```

`aiDomains` 文本框**出厂预填**着默认的 Claude/GPT 规则（`core/web/index.html:161+`），故 `hasAIRules` 对任何未改动该框的用户恒为 `true`。这条校验把「存在 AI 规则」等同于「用户想要 AI 分流」，但预填意味着用户**从未表达过该意图**。

后果：一个只用「中转 + DNS」、不需要任何住宅出口的正当配置会被硬拦截，且提示语要求用户去勾选他并不想要的直连住宅。已在浏览器中稳定复现（1 个中转节点、零住宅、AI 规则保持预填 → 点生成 → 被拦，无产出）。

原 bug 的病根是**静默**，不是**没拦住**。修复方向应是「让它出声」，而非「拦住不放行」。

**规则：**

- 生成的唯一门槛沿用 `app.js:390` 的既有校验——中转节点、中转住宅、直连住宅**三者皆无**才拦截。有其一即放行。
- AI 规则解析不出目标时：**不写入 AI 规则，不阻断生成，但明确提示**。
- 删除 `app.js:378` 这条 AI 专属硬拦截。

「直连住宅」自始至终是可选项。

### 1. `core/lib/ai-target.js` 新增 `resolveAIRules()`

保留现有纯函数 `resolveAITarget()` 不动（已有 13 个单测覆盖），在其上新增一层供生成入口调用：

```js
resolveAIRules({ aiRules, aiExitGroup, residentialGroup, directResidentialGroup, residentials, directResidentials })
  → { aiRules: { ...aiRules, target } | null, skipped: boolean }
```

行为：

- `aiRules` 为空、或其 `domains`/`providers` 均为空 → `{ aiRules: null, skipped: false }`（用户没填规则，正常）
- 否则调 `resolveAITarget()` 求出 target
- target 为 `null` → `{ aiRules: null, skipped: true }`（有规则但无处可去 → 不写入，由调用方转成提示）
- 否则 → `{ aiRules: { ...aiRules, target }, skipped: false }`

**不抛错。** 依据第 0 节：无目标不是错误，是「这批规则本次不适用」。`skipped` 与 `aiRules: null` 分开表达，正是为了把「用户没填规则」（无需提示）和「填了但无处可去」（必须提示）区分开——后者若不提示，就退回成最初那个静默丢弃的 bug。

`hasResidentials` / `hasDirectResidentials` 用 `.some(r => r && r.name)` 判定，与 `core/lib/generate-yaml.js:63-66` 的 `aiExitMembers` 判定一致。这顺带消除了原方案中 `app.js` 用 `length > 0`、生成器用 `.some(...)` 的判定不对称。

### 2. 两个生成入口接入

`verge-plugin/src/routes/api.js` 与 `verge-extension/src/transport-ext.js` 各自在算出 `aiExitGroup` 之后、**完整性校验之前**调用 `resolveAIRules()`，后续一律使用其返回的 `aiRules` 而非原始值。

顺序很关键：解析必须早于完整性校验（`api.js:118` / `transport-ext.js:105`），这样被校验的是**已解析的** target，而不是可能为空的原始值。这实际上收紧了校验——回退链选出的组名也会被完整性校验兜一道。

`skipped` 为 `true` 时，在响应中带回提示：

```js
{ ok: true, yaml: outYaml, notices: ["AI 规则未写入：未配置任何住宅出口（直连住宅或中转住宅）"] }
```

`notices` 是可选数组字段，无提示时可省略。两个宿主返回的形状一致，故 `app.js` 只需一套展示逻辑。Script 输出路径同样带回。

### 3. `core/web/app.js` 简化

删除：

- `resolveTarget` 的取用与调用（连同 `: (aiTarget || aiExitGroup)` 兜底整块）
- 「填写了 AI 规则，但没有任何可用的出口目标」这条 AI 专属硬拦截（见第 0 节）

改为直接组装并原样发送：

```js
const aiRules = hasAIRules ? { target: aiTarget, domains: aiDomains, providers: aiProviders } : null;
```

`target` 允许为空字符串——由服务端解析。`aiExitGroup` 仍按原样发送（未启用时为 `""`）。

`app.js:390` 的既有「至少要有一个出口来源」校验**保持不动**，它是生成的唯一门槛。删掉 AI 专属拦截后，它会自然成为该场景下先触发的那条——这同时消除了原方案中「报错顺序不当」的问题。

生成成功后展示服务端带回的提示：

```js
const notices = (data.notices || []).join("；");
$("genStatus").textContent = `生成成功 [${fmt}] (${bytes} 字节)` + (notices ? ` —— ${notices}` : "");
```

副作用：`app.js` 不再依赖 `window.VergeTransport.resolveAITarget`，两个宿主的 transport 契约重新对齐。

### 4. `verge-extension/src/transport-ext.js` 清理

`window.VergeTransport` 与 Node 侧 `ext` 导出中的 `resolveAITarget` 挂载可以移除——`app.js` 不再需要它，且它本就是为绕开打包限制而加的。`localGenerate` 改为在内部调用 `resolveAIRules()`。

### 5. `verge-plugin` 补回 core gitlink

`.gitmodules` 已声明 `core`，故不能用 `git submodule add`（会报已存在）。做法：把 `verge-core.git` 克隆到 `core/`，检出目标 commit，再 `git add core`——git 检测到 `core/.git` 存在时会自动创建 gitlink。

指针指向本次改动后的 core 最新 commit。

## 数据流（改动后）

```
用户输入
  → core/web/app.js 读 DOM
     ├─ 校验：中转/中转住宅/直连住宅 三者皆无 → 拦截（唯一门槛）
     └─ 原样发送 { aiRules:{target(可空), domains, providers}, aiExitGroup, ... }
  → 生成入口（二选一）:
      verge-extension: src/transport-ext.js localGenerate()
      verge-plugin:    src/routes/api.js   POST /api/generate
    ├─ resolveAIRules()  ← 回退链在此解析；无出口可用 → aiRules=null + skipped=true
    ├─ 目标引用完整性校验（校验的是已解析的 target）
    ├─ 死循环防御
    ├─ core/lib/generate-yaml.js  或  core/lib/generate-script.js
    └─ 响应带 notices[]（skipped 时）
  → app.js 在状态栏展示 notices
```

## 顺带修掉的既有问题

本设计一并消除 `verge-extension` 最终整分支审查遗留的三个 Minor：

| 原 Minor | 如何消除 |
| --- | --- |
| `app.js` 报错顺序：AI 校验抢在「至少要有一个出口来源」之前 | AI 专属拦截整块删除（第 0 节），出口来源校验成为唯一门槛 |
| `app.js` 的 `: (aiTarget \|\| aiExitGroup)` 死代码兜底 | 整块删除 |
| `app.js` 用 `length > 0` 与 `generate-yaml.js` 的 `.some(r => r && r.name)` 判定不对称 | 判定收归 `resolveAIRules()` 一处，统一用 `.some(...)` |

值得记下的是：这三个 Minor 当时都被判为「可发布」，而第一个（报错顺序）正是用户实测撞上的那个回归的一体两面——审查方准确指出了「预填导致 `hasAIRules` 恒真」这一事实，只是把后果估轻了，判成观感问题而非阻断问题。

## 测试

**`core/test/ai-target.test.js`**（补充，现有 13 例不动）：

- `aiRules` 为 `null` → `{ aiRules: null, skipped: false }`
- `aiRules.domains` 与 `providers` 均为空 → `{ aiRules: null, skipped: false }`
- `aiRules.target` 已填 → 原样返回该 target，`skipped: false`
- `target` 空 + 启用总出口组 + 有直连 → target 为总出口组名
- `target` 空 + 未启用总出口组 + 仅有直连 → target 为直连住宅组名
- `target` 空 + 未启用总出口组 + 仅有中转 → target 为住宅节点组名
- **`target` 空 + 无任何住宅 → `{ aiRules: null, skipped: true }`，不抛错**（第 0 节的核心断言）
- `directResidentials` 含无 `name` 的条目 → 不计入成员（验证判定与生成器一致）

**`verge-extension/test/transport-ext.test.js`**（改写原有的 `resolveAITarget` 导出断言）：

- `localGenerate` 收到 `aiRules.target` 为空 + 有直连住宅 → 产出的 YAML 中 AI 规则指向直连住宅组
- `localGenerate` 收到 AI 规则 + 无任何住宅、但有中转 → **成功产出 YAML**（不抛错），YAML 中无 AI 规则，且 `notices` 含「AI 规则未写入」

**`verge-plugin/test/generate.test.js`**（补充）：

- `POST /api/generate`，`aiRules.target` 为空 + 有直连住宅 → 200，YAML 中 AI 规则指向直连住宅组
- `POST /api/generate`，有 AI 规则 + 无任何住宅、但有中转 → **200**（非 400），YAML 中无 AI 规则，响应 `notices` 含「AI 规则未写入」

**浏览器实测**（控制方执行，自动化测试覆盖不到）：

- 复现用户场景：仅勾 1 个中转节点、零住宅、AI 规则保持预填 → 点生成 → **成功产出配置**，状态栏显示「AI 规则未写入」提示。这是本次回归的验收判据。

## 实施注意

改动跨三个仓库，提交顺序有依赖：

1. **core**：新增 `resolveAIRules()`、简化 `app.js`；提交并推送（两个宿主都要拉到它）
2. **verge-extension**：`transport-ext.js` 接入 + 清理挂载；bump submodule 指针
3. **verge-plugin**：`api.js` 接入；补 core gitlink

`verge-plugin/CLAUDE.md` 约定：提交信息用 Conventional Commits，**不加 `Co-Authored-By`**，且不得出现 Claude 相关字样。该约定仅适用于 `verge-plugin` 仓库。

`verge-extension` 已发布 0.1.1（含旧方案）。本次改动后需重新打包发布 0.1.2。

**0.1.1 带有第 0 节所述的阻断性回归**：无住宅出口的用户无法生成配置。这比「verge-plugin 回退链不生效」严重得多，0.1.2 应尽快发布。若 0.1.1 已上架商店，可考虑先下架或加急替换。

## 不做的事

- 不改动 `core/lib/generate-yaml.js`、`core/lib/generate-script.js` 的规则注入逻辑
- 不改动 `resolveAITarget()` 纯函数本身及其 13 个现有单测
- 不给 `verge-plugin` 引入打包器
- 不合并 `api.js` 与 `localGenerate` 这两份孪生实现（诱人，但超出本次范围）
