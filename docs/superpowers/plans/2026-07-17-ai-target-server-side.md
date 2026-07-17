# AI 出口目标解析下沉到服务端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉「AI 规则无出口目标时阻断生成」的回归，并把回退链解析下沉到生成入口，使 `verge-extension` 与 `verge-plugin` 两个宿主共用同一实现。

**Architecture:** 回退链解析从浏览器侧的 `core/web/app.js` 移到两个生成入口（`verge-extension/src/transport-ext.js` 的 `localGenerate()`、`verge-plugin/src/routes/api.js` 的 `POST /api/generate`），两者调用 `core` 新增的 `resolveAIRules()`。解析不出目标时不抛错、不阻断，返回 `skipped` 标志，由入口转成响应中的 `notices[]`，`app.js` 展示。

**Tech Stack:** 原生 JS（CommonJS），`node --test` + `node:assert`，express（verge-plugin），esbuild（verge-extension），js-yaml。

## Global Constraints

- 改动跨三个仓库，提交顺序有依赖：**core → verge-extension → verge-plugin**。
- **`verge-plugin` 仓库的提交信息约定**（其 `CLAUDE.md`）：Conventional Commits；**不加 `Co-Authored-By`**；**不得出现 Claude 相关字样**。此约定**仅适用于 `verge-plugin`**，另两个仓库不受此限。
- `core/web/app.js` 被 `verge-extension/build/build-ext.mjs:13` 原样拷贝、由 `index.html:304` 以普通 `<script>` 加载；`verge-plugin/src/server.js:17` 用 `express.static` 直接托管同一份。**`app.js` 中禁止 `require()`**。
- 回退链优先级恒为：手填 target → AI 总出口组 → 直连住宅 → 住宅节点 → 无（`null`）。「直连优先于中转」。
- 分组名缺省值固定且必须精确：`"AI 总出口"` / `"直连住宅"` / `"住宅节点"`。
- **生成的唯一门槛**是 `core/web/app.js:390` 的既有校验：中转节点、中转住宅、直连住宅三者皆无才拦截。有其一即放行。「直连住宅」是可选项。
- **AI 规则解析不出目标时：不写入 AI 规则、不阻断生成、必须提示。** 静默丢弃是本项目最初要修的 bug，不得复现。
- `resolveAIRules()` **不抛错**。
- 成员判定统一用 `.some(r => r && r.name)`，与 `core/lib/generate-yaml.js:63-66` 一致。
- 不改动 `core/lib/generate-yaml.js`、`core/lib/generate-script.js`。
- 不改动 `resolveAITarget()` 纯函数本身及其 13 个现有单测。
- `verge-extension` 版本号保持 `0.1.1`（尚未上架，直接覆盖重打）。

## File Structure

**core submodule**（`https://github.com/jcoder-stack/verge-core.git`，当前在 `main`）：

| 文件 | 职责 |
| --- | --- |
| `core/lib/ai-target.js` | 新增 `resolveAIRules()`；`resolveAITarget()` 保持不动 |
| `core/test/ai-target.test.js` | 补 `resolveAIRules()` 单测；现有 13 例不动 |
| `core/index.js` | 导出 `resolveAIRules` |
| `core/web/app.js` | 删解析块与 AI 专属拦截；展示 notices |

**verge-extension**（当前在 `main`）：

| 文件 | 职责 |
| --- | --- |
| `src/transport-ext.js` | `localGenerate` 调 `resolveAIRules`、回带 notices；移除 `resolveAITarget` 挂载 |
| `test/transport-ext.test.js` | 改写导出断言为行为断言 |

**verge-plugin**（当前在 `main`）：

| 文件 | 职责 |
| --- | --- |
| `core` | 补回缺失的 submodule gitlink |
| `src/routes/api.js` | `/api/generate` 调 `resolveAIRules`、回带 notices |
| `test/generate.test.js` | 补两个用例 |

---

### Task 1: `resolveAIRules()` 与单测

**Files:**
- Modify: `core/lib/ai-target.js`
- Modify: `core/test/ai-target.test.js`
- Modify: `core/index.js`

**工作目录：** `/Users/zhjie/repose/Github/jc-stack/proxy/verge-extension/core`（git submodule，独立仓库，在 `main` 分支）

**Interfaces:**
- Consumes: 同文件既有的 `resolveAITarget(input) → string | null`
- Produces: `resolveAIRules(opts) → { aiRules, skipped }`，从 `core/lib/ai-target.js` 与 `core/index.js` 两处导出
  - `opts`: `{ aiRules?, aiExitGroup?, residentialGroup?, directResidentialGroup?, residentials?, directResidentials? }`
  - 返回 `{ aiRules: {...原aiRules, target} | null, skipped: boolean }`
  - **不抛错**

- [ ] **Step 1: 写失败的测试**

在 `core/test/ai-target.test.js` 末尾追加（现有 13 例保持不动）：

```js
// ---- resolveAIRules：生成入口用的解析层 ----

const { resolveAIRules } = require("../lib/ai-target");

const RULES = { target: "", domains: ["claude.ai"], providers: [] };
const DIRECT_NODE = { name: "US-ATT", type: "ss", server: "9.9.9.9", port: 8388 };
const RELAY_NODE = { name: "住宅-1", type: "socks5", server: "h", port: 1 };

test("resolveAIRules: aiRules 为 null → 不写入且无需提示", () => {
  const r = resolveAIRules({ aiRules: null, directResidentials: [DIRECT_NODE] });
  assert.deepStrictEqual(r, { aiRules: null, skipped: false });
});

test("resolveAIRules: domains 与 providers 均为空 → 不写入且无需提示", () => {
  const r = resolveAIRules({
    aiRules: { target: "", domains: [], providers: [] },
    directResidentials: [DIRECT_NODE],
  });
  assert.deepStrictEqual(r, { aiRules: null, skipped: false });
});

test("resolveAIRules: 手填 target 原样保留", () => {
  const r = resolveAIRules({
    aiRules: { target: "高速中转", domains: ["claude.ai"], providers: [] },
    aiExitGroup: "AI 总出口",
    directResidentials: [DIRECT_NODE],
  });
  assert.strictEqual(r.aiRules.target, "高速中转");
  assert.strictEqual(r.skipped, false);
});

test("resolveAIRules: target 空 + 启用总出口组 + 有直连 → 总出口组", () => {
  const r = resolveAIRules({
    aiRules: { ...RULES },
    aiExitGroup: "AI 总出口",
    directResidentials: [DIRECT_NODE],
  });
  assert.strictEqual(r.aiRules.target, "AI 总出口");
  assert.strictEqual(r.skipped, false);
});

test("resolveAIRules: target 空 + 未启用总出口组 + 仅有直连 → 直连住宅组", () => {
  const r = resolveAIRules({
    aiRules: { ...RULES },
    aiExitGroup: "",
    directResidentialGroup: "直连住宅",
    directResidentials: [DIRECT_NODE],
  });
  assert.strictEqual(r.aiRules.target, "直连住宅");
});

test("resolveAIRules: target 空 + 未启用总出口组 + 仅有中转住宅 → 住宅节点组", () => {
  const r = resolveAIRules({
    aiRules: { ...RULES },
    aiExitGroup: "",
    residentialGroup: "住宅节点",
    residentials: [RELAY_NODE],
  });
  assert.strictEqual(r.aiRules.target, "住宅节点");
});

test("resolveAIRules: 有规则但无任何住宅 → 不写入 + skipped，且不抛错", () => {
  const r = resolveAIRules({ aiRules: { ...RULES }, aiExitGroup: "AI 总出口" });
  assert.deepStrictEqual(r, { aiRules: null, skipped: true });
});

test("resolveAIRules: 无 name 的直连条目不计入成员（判定与生成器一致）", () => {
  const r = resolveAIRules({
    aiRules: { ...RULES },
    aiExitGroup: "AI 总出口",
    directResidentials: [{ type: "ss", server: "1.1.1.1" }],
  });
  assert.deepStrictEqual(r, { aiRules: null, skipped: true });
});

test("resolveAIRules: 保留原 aiRules 的 domains 与 providers", () => {
  const r = resolveAIRules({
    aiRules: { target: "", domains: ["claude.ai", "openai.com"], providers: [{ name: "AI", url: "http://x/y.yaml" }] },
    aiExitGroup: "AI 总出口",
    directResidentials: [DIRECT_NODE],
  });
  assert.deepStrictEqual(r.aiRules.domains, ["claude.ai", "openai.com"]);
  assert.deepStrictEqual(r.aiRules.providers, [{ name: "AI", url: "http://x/y.yaml" }]);
});

test("resolveAIRules: 入参为 undefined → 不抛错", () => {
  assert.deepStrictEqual(resolveAIRules(undefined), { aiRules: null, skipped: false });
});

test("resolveAIRules 从 core/index.js 导出", () => {
  const core = require("../index.js");
  assert.strictEqual(typeof core.resolveAIRules, "function");
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
node --test test/ai-target.test.js
```

Expected: FAIL —— `resolveAIRules is not a function`

- [ ] **Step 3: 实现 `resolveAIRules`**

在 `core/lib/ai-target.js` 的 `resolveAITarget` 之后、`module.exports` 之前插入：

```js
// 生成入口用的解析层：把请求体里的 aiRules 解析成 target 已填好的形态。
// 无可用目标时返回 { aiRules: null, skipped: true } —— 不抛错：无目标不是错误，
// 只是这批规则本次不适用。skipped 与 aiRules:null 分开表达，是为了让调用方能区分
// 「用户没填规则」（无需提示）与「填了但无处可去」（必须提示，否则退回静默丢弃的老 bug）。
function resolveAIRules(opts) {
  const {
    aiRules,
    aiExitGroup,
    residentialGroup,
    directResidentialGroup,
    residentials,
    directResidentials,
  } = opts || {};

  const hasRules =
    !!aiRules &&
    typeof aiRules === "object" &&
    ((Array.isArray(aiRules.domains) && aiRules.domains.length > 0) ||
      (Array.isArray(aiRules.providers) && aiRules.providers.length > 0));
  if (!hasRules) return { aiRules: null, skipped: false };

  // 成员判定与 generate-yaml.js 的 aiExitMembers 保持一致：无 name 的条目不算数
  const target = resolveAITarget({
    aiTarget: aiRules.target,
    aiExitGroupEnabled: !!aiExitGroup,
    aiExitGroupName: aiExitGroup,
    residentialGroup,
    directResidentialGroup,
    hasResidentials: Array.isArray(residentials) && residentials.some((r) => r && r.name),
    hasDirectResidentials:
      Array.isArray(directResidentials) && directResidentials.some((r) => r && r.name),
  });

  if (!target) return { aiRules: null, skipped: true };
  return { aiRules: { ...aiRules, target }, skipped: false };
}
```

并把 `module.exports` 改为：

```js
module.exports = { resolveAITarget, resolveAIRules };
```

- [ ] **Step 4: 从 `core/index.js` 导出**

把 `require("./lib/ai-target")` 那行与 `module.exports` 中的对应项改为同时带上 `resolveAIRules`：

```js
const { resolveAITarget, resolveAIRules } = require("./lib/ai-target");
```

```js
module.exports = {
  tryDecodeSubscription, summarize,
  buildYaml, buildAIRuleLine, HttpError,
  buildOverrideScript, resolveAITarget, resolveAIRules, decodeBase64,
};
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
node --test
```

Expected: PASS，46 个测试全通过（原 35 + 新增 11），既有测试无回归

- [ ] **Step 6: 提交**

```bash
git add lib/ai-target.js test/ai-target.test.js index.js
git commit -m "feat: 新增 resolveAIRules 生成入口解析层

无可用出口目标时返回 { aiRules: null, skipped: true } 而非抛错，
供调用方转成提示而不阻断生成。"
```

---

### Task 2: `core/web/app.js` 去掉阻断、展示提示

**Files:**
- Modify: `core/web/app.js`

**工作目录：** `/Users/zhjie/repose/Github/jc-stack/proxy/verge-extension/core`

**Interfaces:**
- Consumes: 生成入口响应新增的可选字段 `notices: string[]`（Task 3 / Task 4 产出）
- Produces: 请求体中 `aiRules` 形状变为 `{ target(可为空字符串), domains, providers } | null`；`aiExitGroup` 不变（字符串，未启用时 `""`）

**背景（实施者必读）：** 这是本次修复的核心。当前 `app.js` 在浏览器侧解析回退链并硬拦截，导致「只用中转、不要住宅」的正当配置无法生成——因为 `aiDomains` 文本框出厂预填，`hasAIRules` 恒为真。解析下沉到服务端后，`app.js` 只管收集与发送。

- [ ] **Step 1: 删除回退链解析与 AI 专属拦截**

删除 `app.js` 中从 `// 6) AI 出口目标回退链` 注释开始、到 `aiRules` 赋值结束的整段（位于 `directResidentialGroup` 定义之后、`// 中转可选` 注释之前）：

```js
  // 6) AI 出口目标回退链：手填 → AI 总出口组 → 直连住宅 → 住宅节点。
  // 放在这里是因为回退链要用到上面刚算出的 directResidentials。
  const aiExitGroup = ($("aiExitGroupEnabled") && $("aiExitGroupEnabled").checked)
    ? ($("aiExitGroupName").value.trim() || "AI 总出口")
    : "";
  const resolveTarget = window.VergeTransport && window.VergeTransport.resolveAITarget;
  const aiTargetFinal = resolveTarget
    ? resolveTarget({
        aiTarget,
        aiExitGroupEnabled: !!aiExitGroup,
        aiExitGroupName: aiExitGroup,
        residentialGroup: residentialGroupName(),
        directResidentialGroup,
        hasResidentials: residentials.length > 0,
        hasDirectResidentials: directResidentials.length > 0,
      })
    : (aiTarget || aiExitGroup);

  const hasAIRules = aiDomains.length > 0 || aiProviders.length > 0;
  // 有规则却无处可去 → 明确报错。这是原先规则被静默丢弃的那条路径。
  if (hasAIRules && !aiTargetFinal) {
    return { error: "填写了 AI 规则，但没有任何可用的出口目标：请在「2.5 直连住宅订阅」勾选直连节点，或在上方添加中转住宅，再生成。" };
  }
  const aiRules = hasAIRules
    ? { target: aiTargetFinal, domains: aiDomains, providers: aiProviders }
    : null;
```

- [ ] **Step 2: 换成纯收集，不解析不拦截**

在同一位置插入：

```js
  // 6) AI 规则原样收集：出口目标的回退链解析在生成入口（服务端/localGenerate）完成。
  // 此处不解析、不拦截 —— aiDomains 出厂预填，据其阻断生成会误伤「只用中转、不要住宅」的正当配置。
  const aiExitGroup = ($("aiExitGroupEnabled") && $("aiExitGroupEnabled").checked)
    ? ($("aiExitGroupName").value.trim() || "AI 总出口")
    : "";
  const hasAIRules = aiDomains.length > 0 || aiProviders.length > 0;
  const aiRules = hasAIRules
    ? { target: aiTarget, domains: aiDomains, providers: aiProviders }
    : null;
```

`aiTarget` 可为空字符串，由生成入口解析。`app.js:390` 的「至少要有一个出口来源」校验保持不动——它是生成的唯一门槛。

- [ ] **Step 3: 在生成成功时展示 notices**

`app.js:428` 当前是：

```js
    setStatus("genStatus", `生成成功 [${format}] (${out.length} 字节)`, "ok");
```

改为：

```js
    const notices = (data.notices || []).join("；");
    setStatus("genStatus", `生成成功 [${format}] (${out.length} 字节)` + (notices ? ` —— ${notices}` : ""), notices ? "warn" : "ok");
```

- [ ] **Step 4: ClashMi 导出路径同样展示**

`app.js:461` 当前是：

```js
    setStatus("genStatus", `已导出 ClashMi YAML (${out.length} 字节)`, "ok");
```

改为：

```js
    const notices = (data.notices || []).join("；");
    setStatus("genStatus", `已导出 ClashMi YAML (${out.length} 字节)` + (notices ? ` —— ${notices}` : ""), notices ? "warn" : "ok");
```

- [ ] **Step 5: 新增 `warn` 状态样式**

`web/style.css` 目前只有 `.status.err` 与 `.status.ok`（第 46-47 行），**没有 `.warn`**——不加的话提示会渲染成无样式的默认灰，与「这是个需要注意的提示」不符。

这是深色主题：`.err` 为深红底 + 浅红字，`.ok` 为深绿底 + 浅绿字。`.warn` 按同构的琥珀色配对，紧跟在 `.status.ok` 之后添加：

```css
.status.warn { background: #3a2f1a; color: #fcd34d; }
```

- [ ] **Step 6: 确认 app.js 中无 require**

```bash
grep -n "require(" web/app.js
```

Expected: 无输出

- [ ] **Step 7: 提交**

```bash
git add web/app.js web/style.css
git commit -m "fix: AI 规则无出口目标时不再阻断生成

aiDomains 出厂预填导致 hasAIRules 恒为真，据其硬拦截会让
「只用中转、不要住宅」的正当配置无法生成。回退链解析下沉到生成入口，
app.js 只收集不解析；无目标时由 notices 提示而非报错。"
```

---

### Task 3: `verge-extension` 生成入口接入

**Files:**
- Modify: `src/transport-ext.js`
- Modify: `test/transport-ext.test.js`

**工作目录：** `/Users/zhjie/repose/Github/jc-stack/proxy/verge-extension`（外层仓库，`main` 分支）

**Interfaces:**
- Consumes: `resolveAIRules` from `core/index.js`（Task 1）
- Produces: `localGenerate` 返回值新增可选字段 `notices: string[]`（Task 2 的 `app.js` 消费）

- [ ] **Step 1: 写失败的测试**

把 `test/transport-ext.test.js` 中现有的这个测试**整个替换**掉：

```js
test("transport-ext 导出 resolveAITarget 供 UI 调用", () => {
  const ext = require("../src/transport-ext.js");
  assert.strictEqual(typeof ext.resolveAITarget, "function");
  // 回退链已在 core/test/ai-target.test.js 全覆盖，此处只验证接线未断
  assert.strictEqual(
    ext.resolveAITarget({ hasDirectResidentials: true, directResidentialGroup: "直连住宅" }),
    "直连住宅"
  );
});
```

替换为：

```js
const SUB_YAML = "proxies:\n  - { name: vps1, type: ss, server: 1.2.3.4, port: 443 }\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n";
const DIRECT_NODE = { name: "US-ATT", type: "ss", server: "9.9.9.9", port: 8388 };

test("localGenerate: aiRules.target 为空 + 有直连住宅 → 回退到直连住宅组", async () => {
  const data = await localGenerate({
    yaml: SUB_YAML,
    relay: { name: "高速中转", type: "select", proxies: ["vps1"] },
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    aiExitGroup: "",
    aiRules: { target: "", domains: ["claude.ai"], providers: [] },
  });
  assert.match(data.yaml, /DOMAIN-SUFFIX,claude\.ai,直连住宅/);
});

test("localGenerate: 有 AI 规则 + 无任何住宅 → 仍成功产出，AI 规则不写入且带提示", async () => {
  const data = await localGenerate({
    yaml: SUB_YAML,
    relay: { name: "高速中转", type: "select", proxies: ["vps1"] },
    aiExitGroup: "AI 总出口",
    aiRules: { target: "", domains: ["claude.ai"], providers: [] },
  });
  assert.strictEqual(typeof data.yaml, "string");
  assert.doesNotMatch(data.yaml, /claude\.ai/);
  assert.ok(Array.isArray(data.notices), "应带回 notices");
  assert.match(data.notices.join("；"), /AI 规则未写入/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
node --test test/transport-ext.test.js
```

Expected: FAIL —— 第一个用例因 target 为空而生成不出 AI 规则；第二个用例因无 `notices` 字段而失败

- [ ] **Step 3: 接入 `resolveAIRules`**

顶部 require 块中，把 `resolveAITarget` 换成 `resolveAIRules`：

```js
const {
  tryDecodeSubscription,
  summarize,
  buildYaml,
  buildOverrideScript,
  resolveAIRules,
} = require("../core");
```

在 `localGenerate` 内，`aiExitMembers` 计算完成之后、「目标引用完整性校验」代码块**之前**，插入：

```js
  // AI 出口目标回退链：在此解析，两个宿主（扩展 / verge-plugin）共用同一实现。
  // 无可用目标 → 不写入 AI 规则、不阻断生成，转成 notices 提示。
  const { aiRules: resolvedAIRules, skipped: aiSkipped } = resolveAIRules({
    aiRules,
    aiExitGroup,
    residentialGroup,
    directResidentialGroup,
    residentials,
    directResidentials,
  });
  const notices = aiSkipped
    ? ["AI 规则未写入：未配置任何住宅出口（直连住宅或中转住宅）"]
    : [];
```

- [ ] **Step 4: 全文改用 `resolvedAIRules` 并回带 notices**

在 `localGenerate` 中，把「目标引用完整性校验」之后所有使用 `aiRules` 的位置改为 `resolvedAIRules`。共三处：

1. 完整性校验中的 `if (aiRules && aiRules.target && ...)` → `if (resolvedAIRules && resolvedAIRules.target && ...)`，其中 `missing.push(\`AI 出口目标 "${aiRules.target}"\`)` → `resolvedAIRules.target`
2. `buildOverrideScript({ ..., aiRules, ... })` → `aiRules: resolvedAIRules`
3. `buildYaml({ ..., aiRules, ... })` → `aiRules: resolvedAIRules`

三处返回语句加上 notices：

```js
      return { ok: true, format: "script", script, notices };
```

```js
    if (outputFormat === "clashmi") return { ok: true, format: "clashmi", yaml: outYaml, notices };
    return { ok: true, yaml: outYaml, notices };
```

- [ ] **Step 5: 移除 `resolveAITarget` 挂载**

`app.js` 已不再需要它。文件末尾两处改为：

```js
// 浏览器侧统一挂载契约
if (typeof window !== "undefined") {
  window.VergeTransport = { supportsHook: false, apiFetch, apiParse: localParse, apiGenerate: localGenerate };
}

const ext = { localParse, localGenerate, apiFetch };
if (typeof module !== "undefined" && module.exports) module.exports = ext;
```

- [ ] **Step 6: 运行测试，确认通过**

```bash
node --test test/*.test.js
```

Expected: PASS，4 个测试全通过

- [ ] **Step 7: 提交**

```bash
git add src/transport-ext.js test/transport-ext.test.js
git commit -m "fix: localGenerate 接入 resolveAIRules，无住宅出口时提示而非阻断

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `verge-plugin` 补 gitlink 并接入生成入口

**Files:**
- Create: `core`（submodule gitlink）
- Modify: `src/routes/api.js`
- Modify: `test/generate.test.js`

**工作目录：** `/Users/zhjie/repose/Github/jc-stack/proxy/verge-plugin`（`main` 分支）

**Interfaces:**
- Consumes: `resolveAIRules` from `core/index.js`（Task 1）
- Produces: `POST /api/generate` 响应新增可选字段 `notices: string[]`

**⚠️ 本仓库提交信息约定（其 `CLAUDE.md`）：不加 `Co-Authored-By`，不得出现 Claude 相关字样。**

**背景：** 该仓库的 `.gitmodules` 声明了 `core`，但提交树中没有 gitlink，磁盘上也没有 `core/` 目录，导致 `require("../../core")` 抛 MODULE_NOT_FOUND，仓库无法运行。因 `.gitmodules` 已有条目，`git submodule add` 会报「已存在」，故改用「克隆 + `git add`」的方式建立 gitlink。

- [ ] **Step 1: 补回 core submodule**

```bash
git clone https://github.com/jcoder-stack/verge-core.git core
git -C core checkout main
git -C core pull origin main
```

Expected: `core/` 目录出现，`git -C core log --oneline -1` 显示 Task 2 的提交

- [ ] **Step 2: 确认仓库可运行**

```bash
npm install
node -e 'require("./src/server.js"); console.log("server 模块加载成功")'
```

Expected: 输出 `server 模块加载成功`（此前会抛 MODULE_NOT_FOUND）

- [ ] **Step 3: 写失败的测试**

在 `test/generate.test.js` 末尾追加（该文件已有 `generate(body)` 辅助函数，直接复用）：

```js
const SUB_YAML_AI = "proxies:\n  - { name: vps1, type: ss, server: 1.2.3.4, port: 443 }\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n";
const DIRECT_NODE_AI = { name: "US-ATT", type: "ss", server: "9.9.9.9", port: 8388 };

test("/api/generate: aiRules.target 为空 + 有直连住宅 → 回退到直连住宅组", async () => {
  const { status, json } = await generate({
    yaml: SUB_YAML_AI,
    relay: { name: "高速中转", type: "select", proxies: ["vps1"] },
    directResidentials: [DIRECT_NODE_AI],
    directResidentialGroup: "直连住宅",
    aiExitGroup: "",
    aiRules: { target: "", domains: ["claude.ai"], providers: [] },
  });
  assert.strictEqual(status, 200);
  assert.match(json.yaml, /DOMAIN-SUFFIX,claude\.ai,直连住宅/);
});

test("/api/generate: 有 AI 规则 + 无任何住宅 → 200 且带提示，不阻断", async () => {
  const { status, json } = await generate({
    yaml: SUB_YAML_AI,
    relay: { name: "高速中转", type: "select", proxies: ["vps1"] },
    aiExitGroup: "AI 总出口",
    aiRules: { target: "", domains: ["claude.ai"], providers: [] },
  });
  assert.strictEqual(status, 200);
  assert.doesNotMatch(json.yaml, /claude\.ai/);
  assert.ok(Array.isArray(json.notices), "应带回 notices");
  assert.match(json.notices.join("；"), /AI 规则未写入/);
});
```

- [ ] **Step 4: 运行测试，确认失败**

```bash
node --test test/generate.test.js
```

Expected: FAIL —— 第二个用例当前返回 400（完整性校验判定「AI 总出口」不存在）

- [ ] **Step 5: 接入 `resolveAIRules`**

`src/routes/api.js:6` 的 require 加上 `resolveAIRules`：

```js
const { tryDecodeSubscription, summarize, buildYaml, buildOverrideScript, resolveAIRules } = require("../../core");
```

在 `aiExitMembers` 计算完成之后（约 `api.js:92`）、「目标引用完整性校验」代码块之前插入：

```js
  // AI 出口目标回退链：在此解析，与 verge-extension 的 localGenerate 共用同一实现。
  // 无可用目标 → 不写入 AI 规则、不阻断生成，转成 notices 提示。
  const { aiRules: resolvedAIRules, skipped: aiSkipped } = resolveAIRules({
    aiRules, aiExitGroup, residentialGroup, directResidentialGroup, residentials, directResidentials,
  });
  const notices = aiSkipped ? ["AI 规则未写入：未配置任何住宅出口（直连住宅或中转住宅）"] : [];
```

- [ ] **Step 6: 全文改用 `resolvedAIRules` 并回带 notices**

把「目标引用完整性校验」之后所有使用 `aiRules` 的位置改为 `resolvedAIRules`。共三处：

1. `api.js:118` 的 `if (aiRules && aiRules.target && ...)` → `resolvedAIRules`，其中 `missing.push(\`AI 出口目标 "${aiRules.target}"\`)` → `resolvedAIRules.target`
2. `api.js:153` 的 `buildOverrideScript({ ..., aiRules, ... })` → `aiRules: resolvedAIRules`
3. `api.js:163` 的 `buildYaml({ ..., aiRules, ... })` → `aiRules: resolvedAIRules`

三处成功响应加上 notices：

```js
      return res.json({ ok: true, format: "script", script, notices });
```

```js
    if (outputFormat === "clashmi") return res.json({ ok: true, format: "clashmi", yaml: outYaml, notices });
    return res.json({ ok: true, yaml: outYaml, notices });
```

- [ ] **Step 7: 运行测试，确认通过**

```bash
npm test
```

Expected: PASS，全部通过（含 `core/test/*.test.js`）

- [ ] **Step 8: 提交（注意本仓库约定）**

```bash
git add core src/routes/api.js test/generate.test.js
git commit -m "fix: 补回 core submodule 并接入 AI 出口目标解析

.gitmodules 声明了 core 但提交树缺 gitlink，导致 require 抛
MODULE_NOT_FOUND、仓库无法运行，现补回并指向最新 core。
/api/generate 接入 resolveAIRules：出口目标的回退链在服务端解析，
无可用目标时不写入 AI 规则、不阻断生成，改由 notices 提示。"
```

---

### Task 5: `verge-extension` 提升指针并重打 0.1.1 包

**Files:**
- Modify: `core`（submodule 指针）

**工作目录：** `/Users/zhjie/repose/Github/jc-stack/proxy/verge-extension`

**Interfaces:**
- Consumes: Task 1 / Task 2 在 core 内的提交
- Produces: `dist/verge-extension-0.1.1.zip`

- [ ] **Step 1: 确认 core 干净且已推送**

```bash
git -C core status --short
git -C core log --oneline -2
```

Expected: status 为空

- [ ] **Step 2: 全量测试**

```bash
(cd core && node --test)
node --test test/*.test.js
```

Expected: 两条均 PASS

- [ ] **Step 3: 提升 submodule 指针并构建**

```bash
git add core
git commit -m "chore: bump core submodule（AI 规则无目标时不阻断生成）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
npm run build:ext
```

Expected: 输出 `built → …/dist/extension` 与 `packed → …/dist/verge-extension-0.1.1.zip`

- [ ] **Step 4: 验证包内确实是修复后的代码**

```bash
node -e '
const { execSync } = require("child_process");
const app = execSync("unzip -p dist/verge-extension-0.1.1.zip ui/app.js").toString();
const tr  = execSync("unzip -p dist/verge-extension-0.1.1.zip ui/transport.js").toString();
console.log("AI 专属拦截已移除:", !app.includes("填写了 AI 规则，但没有任何可用的出口目标"));
console.log("app.js 不再引用 resolveAITarget:", !app.includes("resolveAITarget"));
console.log("app.js 展示 notices:", app.includes("notices"));
console.log("app.js 无 require:", !/\brequire\(/.test(app));
console.log("bundle 含 resolveAIRules:", tr.includes("AI 规则未写入"));
'
```

Expected: 五项均为 `true`

- [ ] **Step 5: 提交**

版本号保持 0.1.1，无需改动 `manifest.json` / `package.json`。zip 在 `dist/`（已 gitignore），不进版本库，故本任务除 submodule 指针外无其他提交内容。

---

## 验收标准

- **用户报的回归**：仅勾 1 个中转节点、零住宅、AI 规则保持预填 → 生成**成功**，状态栏提示「AI 规则未写入」（控制方浏览器实测）
- 有直连住宅、出口目标留空 → AI 规则指向直连住宅组（最初那个修复不退化）
- 三者皆无（无中转、无中转住宅、无直连住宅）→ 仍被 `app.js:390` 拦截
- `verge-plugin` 可运行，`/api/generate` 行为与扩展一致
- 三个仓库测试全绿；`dist/verge-extension-0.1.1.zip` 含修复后代码
