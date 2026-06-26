# Chrome 扩展（可上架版）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `verge-plugin` 改造成一个可上架 Chrome 应用商店、免装 Node 开箱即用的 MV3 扩展，功能除「自定义 Hook」外全部保留。

**Architecture:** 抽出同构核心 + 共享 UI 壳为公开仓 `verge-core`（git submodule）；现有开源仓 `verge-plugin` 改为消费该 submodule，行为不变；新建私有仓 `verge-extension` 同样消费该 submodule，用 esbuild 把核心打进扩展。三件原后端事（拉订阅/UA、解析、生成）由扩展能力在浏览器端替代：`optional_host_permissions` 运行时按域申请、`declarativeNetRequestWithHostAccess` 改 UA、`atob` 解码、纯 JS 生成。

**Tech Stack:** Node ≥18、Express（仅开源 server 仓）、js-yaml、esbuild（扩展打包）、Chrome MV3（`declarativeNetRequestWithHostAccess`、`chrome.permissions`、service worker）、node:test。

## Global Constraints

- 提交规范：Conventional Commits（`feat:`/`fix:`/`refactor:`/`docs:`/`chore:`）。
- **提交信息、PR 等不得出现 "Claude"、"由 Claude 创建" 等关键词；不加 Co-Authored-By 行。**
- 交流与注释用简体中文；commit message 可用英文。
- Node 版本下限：`>=18`（内置 `fetch`）。
- 仓库可见性：`verge-core` 公开、`verge-plugin` 公开、`verge-extension` 私有闭源。
- 扩展合规：MV3，禁止动态代码执行（无 `eval`/`new Function` 跑用户代码）、允许 minify 禁止 obfuscate。
- 伪装 UA 固定值：`clash-verge/1.5.0`。
- submodule 挂载路径统一为仓库根目录 `core/`。
- 设计来源：`docs/superpowers/specs/2026-06-24-chrome-extension-design.md`。

---

## File Structure

### 仓库 `verge-core`（公开，submodule）
- Create `package.json` — name `verge-core`，dependency `js-yaml`，无 main 入口副作用。
- Create `index.js` — 统一导出 `tryDecodeSubscription / summarize / buildYaml / buildOverrideScript / decodeBase64`。
- Move `lib/subscription.js`（从 verge-plugin 迁入，去 Buffer）。
- Move `lib/generate-yaml.js`（迁入，去 vm、runHook 注入）。
- Move `lib/generate-script.js`（迁入，不改逻辑）。
- Create `lib/base64.js` — 同构 `decodeBase64`。
- Move `web/index.html` `web/app.js` `web/style.css`（从 verge-plugin 迁入；app.js 改用 `window.VergeTransport`）。
- Move `test/generate.test.js`（迁入；注入 vm 版 runHook）。
- Create `test/base64.test.js`、`test/subscription.test.js`。

### 仓库 `verge-plugin`（公开，现有）
- Submodule `core/` → verge-core。
- Modify `src/server.js` — 分层静态托管 `core/web` + `transport-web` 覆盖层。
- Modify `src/routes/api.js` — 注入 vm 版 runHook；require 改指 `../../core`。
- Create `src/web-overlay/transport.js` — 网页版 transport（调 `/api/*`，`supportsHook:true`）。
- Delete `src/lib/`、`src/web/`、`test/`（已迁入 verge-core）。

### 仓库 `verge-extension`（私有，新建）
- Submodule `core/` → verge-core。
- Create `package.json` — esbuild devDependency + `build:ext` 脚本。
- Create `src/transport-ext.js` — esbuild 入口；`apiParse/apiGenerate` 调 core，`apiFetch` 走授权+DNR+fetch，`supportsHook:false`。
- Create `manifest.json`、`background.js`、图标 `icons/`。
- Create `build/build-ext.mjs` — 打包 transport-ext + 拷 core/web + manifest/background → `dist/extension/`。
- Create `store/privacy-policy.md`、`store/justifications.md`。
- Create `test/transport-ext.test.js` — 在 Node 下测 `apiParse/apiGenerate` 包装。

---

## 里程碑 A — 共享核心 + 开源 server 接入（行为不变）

> 完成标志：`verge-plugin` 跑 `npm test` 全绿、`npm start` 后页面行为与现状一致；核心已在公开 `verge-core` submodule 中。

### Task 1: 创建 verge-core 仓并迁入 lib/test

**Files:**
- Create: `verge-core/package.json`, `verge-core/index.js`
- Move: `verge-plugin/src/lib/*` → `verge-core/lib/*`；`verge-plugin/test/*` → `verge-core/test/*`

**Interfaces:**
- Produces: `verge-core/index.js` 导出 `{ tryDecodeSubscription, summarize, buildYaml, buildOverrideScript, decodeBase64 }`（decodeBase64 在 Task 2 加入）。

- [ ] **Step 1: 🔧 手动** 在 GitHub 新建**公开**空仓 `verge-core`（用户操作）。本地 `git clone` 到与 `verge-plugin` 同级目录。

- [ ] **Step 2:** 把 `verge-plugin/src/lib/subscription.js`、`generate-yaml.js`、`generate-script.js` 复制进 `verge-core/lib/`；把 `verge-plugin/test/generate.test.js` 复制进 `verge-core/test/`。

- [ ] **Step 3:** 写 `verge-core/package.json`：

```json
{
  "name": "verge-core",
  "version": "0.1.0",
  "description": "Clash Verge 覆写生成器同构核心",
  "main": "index.js",
  "scripts": { "test": "node --test" },
  "engines": { "node": ">=18" },
  "dependencies": { "js-yaml": "^4.1.0" }
}
```

- [ ] **Step 4:** 写 `verge-core/index.js`（decodeBase64 在 Task 2 接好后此处生效）：

```js
const { tryDecodeSubscription, summarize } = require("./lib/subscription");
const { buildYaml, buildAIRuleLine, HttpError } = require("./lib/generate-yaml");
const { buildOverrideScript } = require("./lib/generate-script");
const { decodeBase64 } = require("./lib/base64");

module.exports = {
  tryDecodeSubscription, summarize,
  buildYaml, buildAIRuleLine, HttpError,
  buildOverrideScript, decodeBase64,
};
```

- [ ] **Step 5:** `cd verge-core && npm install`。

- [ ] **Step 6: Commit**

```bash
cd verge-core
git add -A
git commit -m "feat: 迁入同构核心 lib 与测试"
```

---

### Task 2: base64.js 同构改造（去 Buffer）

**Files:**
- Create: `verge-core/lib/base64.js`
- Modify: `verge-core/lib/subscription.js:14`
- Test: `verge-core/test/base64.test.js`

**Interfaces:**
- Produces: `decodeBase64(str: string) -> string`（UTF-8 解码；Node 用 Buffer，浏览器用 atob+TextDecoder）。
- Consumes: `subscription.js` 内改用 `decodeBase64`。

- [ ] **Step 1: 写失败测试** `verge-core/test/base64.test.js`：

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { decodeBase64 } = require("../lib/base64");

test("decodeBase64 解码 ASCII", () => {
  assert.strictEqual(decodeBase64("aGVsbG8="), "hello");
});

test("decodeBase64 解码 UTF-8 中文", () => {
  // "代理" 的 base64
  assert.strictEqual(decodeBase64("5Luj55CG"), "代理");
});

test("decodeBase64 容忍空白", () => {
  assert.strictEqual(decodeBase64("aGVs\nbG8="), "hello");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd verge-core && node --test test/base64.test.js`
Expected: FAIL，`Cannot find module '../lib/base64'`。

- [ ] **Step 3: 写实现** `verge-core/lib/base64.js`：

```js
// 同构 base64 → UTF-8 文本解码。Node 用 Buffer；浏览器用 atob + TextDecoder。
// 注意：不要 require('buffer')，否则 esbuild 会把 Buffer shim 打进扩展包。
function decodeBase64(str) {
  const s = String(str || "");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(s, "base64").toString("utf8");
  }
  const binary = atob(s.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

module.exports = { decodeBase64 };
```

- [ ] **Step 4: 运行确认通过**

Run: `cd verge-core && node --test test/base64.test.js`
Expected: PASS（3 测试）。

- [ ] **Step 5: 改 subscription.js 用 decodeBase64**

`verge-core/lib/subscription.js` 顶部加 `const { decodeBase64 } = require("./base64");`，并把第 14 行：

```js
// 旧
const decoded = Buffer.from(trimmed, "base64").toString("utf8");
// 新
const decoded = decodeBase64(trimmed);
```

- [ ] **Step 6: 写 subscription 测试** `verge-core/test/subscription.test.js`：

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { tryDecodeSubscription } = require("../lib/subscription");

test("明文 YAML 原样返回", () => {
  const y = "proxies:\n  - name: a\n";
  assert.strictEqual(tryDecodeSubscription(y), y.trim());
});

test("base64 订阅被解码", () => {
  const raw = "proxies:\n  - name: vmess-1\n";
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  assert.match(tryDecodeSubscription(b64), /proxies:/);
});
```

- [ ] **Step 7: 运行全部核心测试确认通过**

Run: `cd verge-core && npm test`
Expected: PASS（base64 + subscription + 既有 generate 测试全绿）。

- [ ] **Step 8: Commit**

```bash
cd verge-core
git add -A
git commit -m "refactor: base64 解码同构化，去除 Buffer 硬依赖"
```

---

### Task 3: generate-yaml.js 去 vm、runHook 注入

**Files:**
- Modify: `verge-core/lib/generate-yaml.js:5`（删 vm require）、`:28`（buildYaml 签名）、`:271-282`（vm 块）
- Test: `verge-core/test/generate.test.js`（迁入时已含 hook 用例，改为注入 runHook）

**Interfaces:**
- Produces: `buildYaml(opts, deps = {})`，其中 `deps.runHook(scriptText: string, params: object) -> object`。无 `deps.runHook` 且 `opts.extensionScript` 非空时抛 `HttpError(422)`。`buildYaml` 保持同步。
- Consumes（后续）：verge-plugin 注入 vm 版 runHook；verge-extension 不传 extensionScript，故不触发。

- [ ] **Step 1: 删 vm 依赖** 删除 `verge-core/lib/generate-yaml.js` 第 5 行 `const vm = require("vm");`。

- [ ] **Step 2: 改 buildYaml 签名** 第 28 行 `function buildYaml(opts) {` → `function buildYaml(opts, deps = {}) {`。

- [ ] **Step 3: 替换 vm 块** 把第 271-282 行的 vm 执行块整体替换为注入调用：

```js
  // 4) 扩展脚本：通过注入的 runHook 执行 main(params) 覆写（核心不再直接依赖 vm）
  if (typeof extensionScript === "string" && extensionScript.trim().length > 0) {
    const runHook = deps && deps.runHook;
    if (typeof runHook !== "function") {
      throw new HttpError(422, "extension script not supported in this environment");
    }
    try {
      params = runHook(extensionScript, params) || params;
    } catch (e) {
      throw new HttpError(422, `extension script failed: ${e.message}`);
    }
  }
```

- [ ] **Step 4: 改迁入的 generate 测试注入 runHook** 在 `verge-core/test/generate.test.js` 顶部加一个 vm 版 runHook helper，并把所有 `buildYaml({...})`（带 extensionScript 的用例）改为 `buildYaml({...}, { runHook: vmRunHook })`：

```js
const vm = require("node:vm");
function vmRunHook(script, params) {
  const sandbox = { params, module: { exports: {} }, exports: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(
    `${script}\n;if (typeof main === 'function') { params = main(params) || params; }`,
    sandbox, { timeout: 3000 }
  );
  return sandbox.params;
}
```

> 不带 extensionScript 的 buildYaml 用例无需改动（第二参数缺省为 `{}`）。

- [ ] **Step 5: 运行核心测试确认通过**

Run: `cd verge-core && npm test`
Expected: PASS（含 hook 用例，runHook 注入版本）。

- [ ] **Step 6: Commit**

```bash
cd verge-core
git add -A
git commit -m "refactor: hook 执行改为注入 runHook，核心去除 vm 依赖"
```

---

### Task 4: 共享 UI 壳迁入 + app.js 改用 window.VergeTransport

**Files:**
- Move: `verge-plugin/src/web/{index.html,app.js,style.css}` → `verge-core/web/`
- Modify: `verge-core/web/app.js`（6 处 fetch → VergeTransport；hook 面板按 supportsHook 隐藏）
- Modify: `verge-core/web/index.html`（在 app.js 前先加载 `transport.js`）

**Interfaces:**
- Produces: 全局契约 `window.VergeTransport = { supportsHook: boolean, apiFetch(url)->{yaml,summary}, apiParse(text)->{yaml,summary}, apiGenerate(payload)->{yaml}|{script} }`。三方法失败时 `throw new Error(msg)`。
- Consumes: 各消费仓在 `app.js` 之前注入 `window.VergeTransport`。

- [ ] **Step 1:** 把 `verge-plugin/src/web/` 三个文件复制进 `verge-core/web/`。

- [ ] **Step 2:** `verge-core/web/index.html` 中，在引入 `app.js` 的 `<script>` **之前**插入：

```html
<script src="transport.js"></script>
```

- [ ] **Step 3:** 改 `verge-core/web/app.js`：把 6 处 `fetch("/api/...")` 调用按下表替换为 VergeTransport 调用。模式：去掉 `fetch`+`r.json()`+`if(!r.ok)throw`，改为直接 `await VergeTransport.xxx()`（transport 内部已在失败时抛错）。

  - 第 ~30 行（订阅 URL 拉取）与第 ~579 行（直连住宅订阅拉取）：
    ```js
    // 旧
    const r = await fetch("/api/fetch", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ url }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    // 新
    const data = await window.VergeTransport.apiFetch(url);
    ```
  - 第 ~59 行与第 ~597 行（解析）：
    ```js
    // 旧
    const r = await fetch("/api/parse", { method:"POST", headers:{"Content-Type":"text/plain"}, body: text });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    // 新
    const data = await window.VergeTransport.apiParse(text);
    ```
  - 第 ~424 行与第 ~451 行（生成）：
    ```js
    // 旧
    const r = await fetch("/api/generate", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    // 新
    const data = await window.VergeTransport.apiGenerate(payload);
    ```

- [ ] **Step 4:** 在 `app.js` 初始化处（DOMContentLoaded 或文件末尾的初始化段）加入 hook 面板可见性控制。先在 `index.html` 给「用户自定义扩展 Hook」面板容器补一个 id（如 `hookPanel`），再在 app.js 加：

```js
// 扩展环境不支持 hook：隐藏面板并保证不发送 extensionScript
if (window.VergeTransport && window.VergeTransport.supportsHook === false) {
  const hp = document.getElementById("hookPanel");
  if (hp) hp.style.display = "none";
}
```

> 同时确认收集 payload 的函数（约 app.js:240「收集前端表单 → /api/generate」）在 `hookPanel` 隐藏时不读取其输入：当面板隐藏时 `extensionScript` 取空串。

- [ ] **Step 5: Commit（verge-core）**

```bash
cd verge-core
git add -A
git commit -m "feat: 迁入共享 UI 壳，app.js 改用 window.VergeTransport 传输层"
```

> 本任务的可测交付在 Task 5 接入 verge-plugin 后用手动冒烟验证（浏览器打开页面，行为与现状一致）。

---

### Task 5: verge-plugin 接入 submodule + transport-web + 注入 vmRunHook

**Files:**
- Create submodule: `verge-plugin/core/` → verge-core
- Create: `verge-plugin/src/web-overlay/transport.js`
- Modify: `verge-plugin/src/server.js`、`verge-plugin/src/routes/api.js`
- Delete: `verge-plugin/src/lib/`、`verge-plugin/src/web/`、`verge-plugin/test/`

**Interfaces:**
- Consumes: `core/index.js` 的导出；`window.VergeTransport` 契约。
- Produces: 网页版 transport（`supportsHook:true`，转发到 `/api/*`）。

- [ ] **Step 1: 🔧 删旧 + 加 submodule**

```bash
cd verge-plugin
git rm -r src/lib src/web test
git submodule add https://github.com/jcoder-stack/verge-core.git core
git commit -m "refactor: 移除内嵌 lib/web/test，改为 verge-core submodule"
```

- [ ] **Step 2: 写网页版 transport** `verge-plugin/src/web-overlay/transport.js`：

```js
// 网页版传输层：转发到本地 Express /api/*，保留 hook 能力
window.VergeTransport = {
  supportsHook: true,
  async apiFetch(url) {
    const r = await fetch("/api/fetch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
  async apiParse(text) {
    const r = await fetch("/api/parse", {
      method: "POST", headers: { "Content-Type": "text/plain" }, body: text,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
  async apiGenerate(payload) {
    const r = await fetch("/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};
```

- [ ] **Step 3: 改 server.js 分层静态托管** 让 `/transport.js` 来自 overlay、其余来自 `core/web`。改 `verge-plugin/src/server.js`：

```js
const path = require("path");
// ... 既有 express/json/text 中间件保持不变 ...
// 覆盖层先注册：命中 /transport.js
app.use(express.static(path.join(__dirname, "web-overlay")));
// 再注册共享 UI 壳
app.use(express.static(path.join(__dirname, "..", "core", "web")));
app.use(apiRouter);
```

- [ ] **Step 4: 改 routes/api.js 注入 vmRunHook 并改 require 路径** 顶部 require 从 `../lib/...` 改为核心入口，并加 vm runHook：

```js
const yaml = require("js-yaml");
const vm = require("vm");
const { tryDecodeSubscription, summarize, buildYaml, buildOverrideScript } = require("../../core");

function vmRunHook(script, params) {
  const sandbox = { params, module: { exports: {} }, exports: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(
    `${script}\n;if (typeof main === 'function') { params = main(params) || params; }`,
    sandbox, { timeout: 3000 }
  );
  return sandbox.params;
}
```

并把 `/api/generate` 里 `buildYaml({...})` 调用改为 `buildYaml({...}, { runHook: vmRunHook })`。

- [ ] **Step 5: 改 verge-plugin 测试入口** verge-plugin 自身已无 test/（迁入 verge-core）。核心测试在 verge-core 跑。verge-plugin 的 `package.json` `test` 脚本改为对 submodule 跑：

```json
"scripts": {
  "start": "node src/server.js",
  "dev": "node --watch src/server.js",
  "test": "node --test core/test",
  "postinstall": "cd core && npm install"
}
```

- [ ] **Step 6: 拉起 submodule 依赖并跑测试**

Run: `cd verge-plugin && git submodule update --init && (cd core && npm install) && npm test`
Expected: PASS（核心测试全绿）。

- [ ] **Step 7: 手动冒烟** `cd verge-plugin && npm start`，浏览器开 `http://127.0.0.1:7788`：拉一个订阅、生成 YAML、生成 script、Export ClashMi 各一次，行为与改造前一致；hook 面板仍在（网页版 supportsHook=true）。

- [ ] **Step 8: Commit**

```bash
cd verge-plugin
git add -A
git commit -m "feat: 接入 verge-core submodule 与网页版 transport，注入 vm runHook"
```

> **里程碑 A 交付**：开源 server 仓行为不变、核心在公开 submodule、测试全绿。可在此暂停评审。

---

## 里程碑 B — verge-extension（私有，可上架）

> 完成标志：`dist/extension/` 可 load unpacked，拉订阅/解析/生成/ClashMi 全流程在扩展内跑通；上架素材齐备。

### Task 6: 创建 verge-extension 仓骨架 + submodule + esbuild

**Files:**
- Create: `verge-extension/package.json`
- Create submodule: `verge-extension/core/` → verge-core

**Interfaces:**
- Produces: `npm run build:ext` 脚本（实现见 Task 11）。

- [ ] **Step 1: 🔧 手动** GitHub 新建**私有**空仓 `verge-extension`，本地 clone。

- [ ] **Step 2: 加 submodule**

```bash
cd verge-extension
git submodule add https://github.com/jcoder-stack/verge-core.git core
```

- [ ] **Step 3: 写 package.json**

```json
{
  "name": "verge-extension",
  "version": "0.1.0",
  "private": true,
  "description": "Clash Verge 覆写生成器 Chrome 扩展",
  "scripts": {
    "build:ext": "node build/build-ext.mjs",
    "test": "node --test test"
  },
  "engines": { "node": ">=18" },
  "devDependencies": { "esbuild": "^0.21.0" },
  "dependencies": { "js-yaml": "^4.1.0" }
}
```

- [ ] **Step 4:** `cd verge-extension && (cd core && npm install) && npm install`。

- [ ] **Step 5: Commit**

```bash
cd verge-extension
git add -A
git commit -m "chore: 初始化扩展仓骨架与 verge-core submodule"
```

---

### Task 7: transport-ext 的本地能力（apiParse / apiGenerate）

**Files:**
- Create: `verge-extension/src/transport-ext.js`
- Test: `verge-extension/test/transport-ext.test.js`

**Interfaces:**
- Consumes: `core/index.js` 的 `tryDecodeSubscription / summarize / buildYaml / buildOverrideScript`、`js-yaml`。
- Produces: `window.VergeTransport.apiParse(text)`、`apiGenerate(payload)`、`supportsHook=false`。校验逻辑（目标完整性、死循环防御）在 apiGenerate 内本地执行。

- [ ] **Step 1: 写失败测试** `verge-extension/test/transport-ext.test.js`（在 Node 下测纯逻辑包装；为可测，transport-ext 把核心调用聚合到可导出的纯函数 `localParse` / `localGenerate`，并在浏览器侧再挂到 `window.VergeTransport`）：

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { localParse, localGenerate } = require("../src/transport-ext.js");

test("localParse 解析明文 YAML", async () => {
  const data = await localParse("proxies:\n  - { name: a, type: ss, server: s }\n");
  assert.strictEqual(data.summary.proxyCount, 1);
});

test("localGenerate script 格式产出脚本文本", async () => {
  const data = await localGenerate({
    format: "script",
    relay: { name: "高速中转", type: "select", proxies: ["a"] },
    residentials: [{ name: "住宅", type: "socks5", server: "h", port: 1, username: "u", password: "p" }],
    residentialGroup: "住宅节点",
    aiRules: { target: "住宅节点", lines: ["claude.ai"] },
    dnsAntiLeak: true,
  });
  assert.strictEqual(typeof data.script, "string");
  assert.match(data.script, /main/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd verge-extension && node --test test/transport-ext.test.js`
Expected: FAIL，找不到 `localParse`。

- [ ] **Step 3: 写实现** `verge-extension/src/transport-ext.js`（先实现纯逻辑 + apiParse/apiGenerate；apiFetch 在 Task 8 补；模块同时支持 Node require 测试与浏览器 esbuild 打包）：

```js
const yaml = require("js-yaml");
const {
  tryDecodeSubscription, summarize, buildYaml, buildOverrideScript,
} = require("../core");

// ---- 纯逻辑：可在 Node 下单测 ----
async function localParse(text) {
  const yamlText = tryDecodeSubscription(text);
  let parsed;
  try { parsed = yaml.load(yamlText); }
  catch (e) { throw new Error(`parse failed: ${e.message}`); }
  return { ok: true, yaml: yamlText, summary: summarize(parsed) };
}

async function localGenerate(payload) {
  const p = payload || {};
  // —— 与原 /api/generate 一致的目标完整性校验 + 死循环防御 —— //
  validateGenerate(p, yaml);
  const fmt = p.format === "script" ? "script" : p.format === "clashmi" ? "clashmi" : "yaml";
  if (fmt === "script") {
    return { ok: true, format: "script", script: buildOverrideScript(p) };
  }
  // 扩展端不支持 hook：不注入 runHook；UI 已保证不发送 extensionScript
  const outYaml = buildYaml({ ...p, outputFormat: fmt }, {});
  return fmt === "clashmi" ? { ok: true, format: "clashmi", yaml: outYaml } : { ok: true, yaml: outYaml };
}

// validateGenerate：把 routes/api.js 内的校验逻辑原样搬来（目标节点完整性 + dialer-proxy 死循环）
function validateGenerate(body, yamlLib) {
  // …… 将 verge-plugin/src/routes/api.js 第 85-139 行的校验逻辑整体移植，
  //     失败时 throw new Error(中文提示)（替代原 res.status(400).json）……
}

const ext = { localParse, localGenerate };
if (typeof module !== "undefined" && module.exports) module.exports = ext;
```

> 说明：`validateGenerate` 需把 `verge-plugin/src/routes/api.js` 第 85-139 行的校验逻辑逐行移植为抛错版（把 `return res.status(400).json({error})` 改成 `throw new Error(error)`）。该逻辑较长，实现时对照原文件搬运，不可省略。

- [ ] **Step 4: 运行确认通过**

Run: `cd verge-extension && node --test test/transport-ext.test.js`
Expected: PASS（2 测试）。

- [ ] **Step 5: Commit**

```bash
cd verge-extension
git add -A
git commit -m "feat: transport-ext 本地解析与生成（含校验移植）"
```

---

### Task 8: transport-ext 的 apiFetch（按域授权 + DNR 改 UA + fetch）

**Files:**
- Modify: `verge-extension/src/transport-ext.js`

**Interfaces:**
- Produces: `window.VergeTransport`（浏览器侧）含 `supportsHook:false, apiFetch, apiParse, apiGenerate`。
- Consumes: `chrome.permissions`、`chrome.declarativeNetRequest`、`localParse`。

- [ ] **Step 1: 在 transport-ext.js 追加 apiFetch + 浏览器侧挂载**（DNR 规则用一个固定 id，注册/移除放 try/finally）：

```js
const UA = "clash-verge/1.5.0";
const DNR_RULE_ID = 1733; // 固定占位 id，使用前先清同 id

function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

async function ensureHostPermission(url) {
  const origins = [originPattern(url)];
  const has = await chrome.permissions.contains({ origins });
  if (has) return;
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error("需授权访问该订阅域名才能拉取");
}

async function withUaRule(url, fn) {
  const addRules = [{
    id: DNR_RULE_ID,
    priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "user-agent", operation: "set", value: UA }] },
    condition: { urlFilter: `|${url}`, resourceTypes: ["xmlhttprequest"] },
  }];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [DNR_RULE_ID], addRules });
  try { return await fn(); }
  finally { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [DNR_RULE_ID] }); }
}

async function apiFetch(url) {
  if (!url || typeof url !== "string") throw new Error("missing url");
  await ensureHostPermission(url);
  const text = await withUaRule(url, async () => {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`upstream ${r.status} ${r.statusText}`);
    return r.text();
  });
  return localParse(text); // 复用解码+解析+摘要
}

// 浏览器侧统一挂载契约
if (typeof window !== "undefined") {
  window.VergeTransport = { supportsHook: false, apiFetch, apiParse: localParse, apiGenerate: localGenerate };
}
```

> `apiParse`/`apiGenerate` 直接复用 Task 7 的 `localParse`/`localGenerate`。

- [ ] **Step 2: 运行已有单测确认未回归**

Run: `cd verge-extension && npm test`
Expected: PASS（apiFetch 是浏览器路径，不在 Node 测试内；localParse/localGenerate 仍绿）。

- [ ] **Step 3: Commit**

```bash
cd verge-extension
git add -A
git commit -m "feat: transport-ext apiFetch（按域授权 + DNR 改 UA）"
```

---

### Task 9: manifest.json（MV3）

**Files:**
- Create: `verge-extension/manifest.json`
- Create: `verge-extension/icons/{16,48,128}.png`（占位图标，上架前替换为正式图标）

**Interfaces:**
- Consumes: `background.js`、打包后的 `ui/index.html`。

- [ ] **Step 1: 写 manifest.json**

```json
{
  "manifest_version": 3,
  "name": "Clash Verge 覆写生成器",
  "version": "0.1.0",
  "description": "可视化生成 Clash Verge 订阅覆写：住宅 IP 出口、AI 分流、DNS 防泄漏。",
  "action": { "default_title": "打开覆写生成器" },
  "background": { "service_worker": "background.js" },
  "permissions": ["declarativeNetRequestWithHostAccess"],
  "optional_host_permissions": ["*://*/*"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  },
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

- [ ] **Step 2:** 放入三张占位 PNG 图标（任意纯色方图即可，尺寸 16/48/128）。

- [ ] **Step 3: Commit**

```bash
cd verge-extension
git add -A
git commit -m "feat: 新增 MV3 manifest 与占位图标"
```

---

### Task 10: background.js（点图标开标签页）

**Files:**
- Create: `verge-extension/background.js`

**Interfaces:**
- Consumes: `chrome.action.onClicked`、`chrome.tabs`、`chrome.runtime.getURL`。

- [ ] **Step 1: 写 background.js**

```js
// 点击工具栏图标 → 在新标签页打开完整页面
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/index.html") });
});
```

- [ ] **Step 2: Commit**

```bash
cd verge-extension
git add -A
git commit -m "feat: background 点图标开标签页"
```

---

### Task 11: 构建脚本（esbuild 打包 + 组装 dist）

**Files:**
- Create: `verge-extension/build/build-ext.mjs`

**Interfaces:**
- Consumes: `src/transport-ext.js`、`core/web/*`、`manifest.json`、`background.js`、`icons/*`。
- Produces: `dist/extension/`（含 `ui/`、`manifest.json`、`background.js`、`icons/`）。

- [ ] **Step 1: 写 build-ext.mjs**

```js
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist", "extension");

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "ui"), { recursive: true });

// 1) 拷共享 UI 壳（index.html / app.js / style.css）
await cp(path.join(root, "core", "web"), path.join(out, "ui"), { recursive: true });

// 2) 打包 transport-ext（含 core lib + js-yaml）→ ui/transport.js（IIFE，挂 window.VergeTransport）
await build({
  entryPoints: [path.join(root, "src", "transport-ext.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110"],
  minify: true,
  outfile: path.join(out, "ui", "transport.js"),
});

// 3) 拷 manifest / background / icons
await cp(path.join(root, "manifest.json"), path.join(out, "manifest.json"));
await cp(path.join(root, "background.js"), path.join(out, "background.js"));
await cp(path.join(root, "icons"), path.join(out, "icons"), { recursive: true });

console.log("built →", out);
```

- [ ] **Step 2: 运行构建**

Run: `cd verge-extension && npm run build:ext`
Expected: 输出 `built → .../dist/extension`，`dist/extension/ui/transport.js` 存在且为压缩后的 IIFE。

- [ ] **Step 3:** 把 `dist/` 加入 `verge-extension/.gitignore`（构建产物不入库）。

- [ ] **Step 4: Commit**

```bash
cd verge-extension
git add -A
git commit -m "feat: esbuild 构建脚本，组装 dist/extension"
```

---

### Task 12: load unpacked 冒烟 + 上架素材

**Files:**
- Create: `verge-extension/store/privacy-policy.md`
- Create: `verge-extension/store/justifications.md`

**Interfaces:** 无（验收与文档任务）。

- [ ] **Step 1: 加载扩展** Chrome 开 `chrome://extensions` → 开发者模式 → 加载已解压的 `dist/extension/`。

- [ ] **Step 2: 冒烟（逐项确认）**
  - 点工具栏图标 → 新标签页打开页面，三栏布局正常、**无 hook 面板**。
  - 订阅 URL 拉取 → 首次弹该域授权 → 同意后成功加载节点（UA 已伪装，订阅返回 YAML）。
  - 粘贴 YAML → 解析成功。
  - 选节点 + 填住宅 IP + 选 AI 出口 → 生成「JS 覆写脚本」成功、预览有内容。
  - 切「完整 YAML」「Export for ClashMi」→ 各成功。
  - 复制 / 下载 → 正常。

- [ ] **Step 3: 写隐私政策** `verge-extension/store/privacy-policy.md`（要点：全部本地处理；唯一外发是用户主动填写的订阅地址；不收集、不上传订阅内容与住宅 IP 凭据；无第三方分析）。

- [ ] **Step 4: 写权限用途说明** `verge-extension/store/justifications.md`：
  - `declarativeNetRequestWithHostAccess`：拉取 Clash 订阅时，订阅服务器要求 clash 兼容 `User-Agent` 才返回 YAML，故仅对用户输入的订阅域改写该请求头。
  - `optional_host_permissions`：仅在用户点击「拉取」时，对其输入的订阅域运行时申请最小访问；不在安装时索取全域。
  - 单一用途：生成 Clash Verge/mihomo 订阅覆写配置。

- [ ] **Step 5: Commit**

```bash
cd verge-extension
git add -A
git commit -m "docs: 上架素材（隐私政策、权限用途说明）"
```

- [ ] **Step 6: 🔧 手动（用户）** 注册 Chrome 开发者账号（$5）→ 上传 `dist/extension/` 打包的 zip → 填隐私政策 URL、单一用途与权限用途说明 → 提交审核。

> **里程碑 B 交付**：私有扩展可加载、全流程跑通、上架素材齐备。

---

## Self-Review

**1. Spec coverage（逐节核对设计 → 任务）**
- §3 三仓 submodule 拓扑 → Task 1/5/6（建仓、两消费仓各加 submodule）。✓
- §4.1 核心同构（base64 去 Buffer、generate-yaml 去 vm/runHook 注入、generate-script 不动） → Task 2/3。✓
- §4.2/4.3 UI 复用 + transport 抽象（app.js 单一来源、supportsHook 门控） → Task 4 + transport-web(Task5)/transport-ext(Task7/8)。✓
- §4.4 manifest/background → Task 9/10。✓
- §5 数据流（按域授权 → DNR 改 UA → fetch → finally 移除 → 解码校验摘要；生成 script/yaml/clashmi） → Task 7/8。✓
- §5.1 UA 不能用 fetch headers，须 DNR → Task 8（`modifyHeaders user-agent`）。✓
- §6 功能保留（仅去 hook；扩展隐藏面板不发 extensionScript） → Task 4(Step4)/7/8。✓
- §7 错误处理（授权拒绝提示、upstream 文案、try/finally 移除规则、本地校验抛错） → Task 7/8。✓
- §8 测试（核心 node:test 续守、扩展 transport 单测 + load unpacked 冒烟） → Task 2/3/7 + Task 12。✓
- §9 构建分发（esbuild 打包 + 组装 dist + load unpacked） → Task 11/12。✓
- §10 上架合规（隐私政策、权限最小化、UA 用途、无动态代码、minify、$5 账号） → Task 9/11/12。✓

**2. Placeholder scan**：`validateGenerate`（Task 7 Step3）以「移植 routes/api.js 第 85-139 行」描述而非贴全代码——属有意引用既有源文件逐行搬运，已标注「不可省略」并给出转换规则（`res.status(400).json` → `throw`）；manifest 中 `icons` 为真实路径非占位。无 TBD/TODO。

**3. Type consistency**：`window.VergeTransport` 契约（`supportsHook/apiFetch/apiParse/apiGenerate`）在 Task 4 定义、Task 5（web）与 Task 7/8（ext）实现一致；`buildYaml(opts, deps)` 签名在 Task 3 定义、Task 5 与 Task 7 调用一致（web 传 `{runHook}`，ext 传 `{}`）；`decodeBase64` 在 Task 2 定义、subscription.js 使用一致；`DNR_RULE_ID` 在 Task 8 内自洽。

> 说明：本计划跨 3 个仓库、12 个任务。里程碑 A（Task 1-5）与里程碑 B（Task 6-12）各自产出可独立验收的软件，可分两段评审执行。
