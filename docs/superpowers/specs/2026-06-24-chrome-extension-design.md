# 设计：将 verge-plugin 做成 Chrome 扩展（可上架版）

- **日期**：2026-06-24
- **状态**：设计待评审
- **作者**：Jc.Zhu

---

## 1. 目标与背景

把现有的 `verge-plugin`（本地 Node + Express 的 Clash Verge 订阅覆写生成器）改造成一个 **Chrome 扩展（MV3）**，使其：

1. **免装 Node、开箱即用**——最终用户不再需要安装 Node、跑 `npm start`，装上扩展点一下即可使用。
2. **可上架 Chrome 应用商店做推广**——满足商店审核要求（权限、隐私政策、无动态代码执行、无混淆）。

**功能基线**：除「用户自定义扩展 Hook」一项移除外，现有功能全部保留（详见 §6）。

### 1.1 现状分析

- 前端（`src/web/`）已是纯 HTML/CSS/JS 网页。
- 后端只做三件事：
  1. `/api/fetch`——代理拉取订阅，绕过浏览器 CORS + 把 `User-Agent` 伪装成 clash。
  2. `/api/parse`——`js-yaml` 解析 + Base64 解码。
  3. `/api/generate`——纯 JS 生成逻辑 + 用 Node `vm` 沙箱跑「用户自定义 Hook」。
- 核心生成逻辑在 `src/lib/`（约 580 行，带测试），是项目真正价值所在。

这三件后端事，Chrome 扩展能在浏览器端自行替代：跨域请求用 host 权限、改 UA 用 `declarativeNetRequest`、Base64 用 `atob`。唯一真执行用户 JS 的 Hook 因上架风险移除。

---

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 核心动机 | 免装 Node、开箱即用 + 上架推广 | 用户确认 |
| 代码组织 | **方案 A**：同构核心 + 轻量构建 | 单一来源、不重复、现有测试继续守核心 |
| 界面形态 | **独立标签页** | 三栏复杂布局，弹窗太挤；点图标在新标签页打开 |
| 自定义 Hook | **去掉** | 上架最大拒审点（动态代码执行政策），用户也不需要 |
| 权限模型 | 运行时**按域**申请 + `declarativeNetRequestWithHostAccess` | 商店审核最认的最小化模式 |
| 多仓共享 | **git submodule** | 单一来源、免 npm 发布 |
| 核心可见性 | **公开**，保留开源 server 仓 | 生成逻辑已公开，开源仓可吸 star 做推广 |

### 2.1 两条独立的审核线（澄清）

- **权限线**：manifest 声明的能力（host 权限、`declarativeNetRequest`）。审核看是否过宽/敏感。
- **代码执行线**：MV3 禁止执行不可静态审查的代码（远程代码 / 动态 `eval`/`new Function`）。**与权限无关**，与「数据在哪执行」也无关——只看是否具备动态执行任意 JS 字符串的能力。自定义 Hook 踩的是这条线，故移除后整条线风险消失。

闭源与上架不冲突：商店不要求开源，只要求上传包**可审查**（允许 minify，禁止 obfuscate）。

---

## 3. 仓库拓扑（三仓 + submodule）

```
verge-core         （新建，公开 submodule）
  └─ lib/          同构核心：subscription / generate-yaml / generate-script / base64
  └─ test/         核心测试（node:test）

verge-plugin       （现有，保持公开）— 开源 server 运行壳
  └─ src/server.js, routes/api.js, web/
  └─ vendor/core → submodule(verge-core)

verge-extension    （新建，私有闭源）— 扩展产品
  └─ manifest.json, background.js, ui/, transport-ext.js, build/, store-assets/
  └─ vendor/core → submodule(verge-core)
```

- 核心改一次，两个消费仓各自 bump submodule 指针。
- `verge-core` 公开：生成逻辑反正已公开，开源 server 仓继续可构建；只有 `verge-extension` 产品仓闭源。

> 迁移注意：现有 `verge-plugin` 的 `src/lib/` 与 `test/` 迁入 `verge-core`，原仓改为 submodule 引用。

---

## 4. 架构与组件

### 4.1 核心层（verge-core，同构）

对外暴露：`tryDecodeSubscription` / `summarize` / `buildYaml` / `buildOverrideScript`。同一份代码 Node 与浏览器都能 import。三处改造：

1. **`subscription.js` 去 Buffer**：`Buffer.from(x,'base64')` → `decodeBase64(x)`（来自新增 `base64.js`）。
2. **`base64.js`（新增）**：运行时分支——浏览器用 `atob` + `TextDecoder`，Node 用 `Buffer`。对外只暴露 `decodeBase64(str)`，两端行为一致。
3. **`generate-yaml.js` 去 vm**：删掉顶部 `require("vm")`，hook 执行改为**注入的 `runHook`**：
   ```js
   function buildYaml(opts, { runHook } = {}) {
     // ...
     if (extensionScript && runHook) params = runHook(extensionScript, params);
   }
   ```
   - `buildYaml` **保持同步**（hook 已去，扩展端永不传 `extensionScript`，故永不调 `runHook`，`vm` 也不会被打进扩展包）。
   - server 端调用时注入 vm 版 `runHook`（本地服务器仍支持 hook，功能不退化）。
4. **`generate-script.js`**：基本不动；「末尾追加用户 hook」段在扩展构建里因不传 `extensionScript` 自然不启用。

### 4.2 UI 层（verge-extension/ui，复用 src/web）

`index.html` / `style.css` / `app.js` 复用现有网页。`app.js` 里三处 `fetch('/api/...')` 抽成 **transport 接口**（见 4.3），UI 本体两端共用，去掉「自定义扩展 Hook」面板。

### 4.3 transport 抽象（让 app.js 单一来源）

统一接口（两端同签名）：

```js
apiFetch(url)         → { ok, yaml, summary }     // 拉订阅
apiParse(text)        → { ok, yaml, summary }     // 解析
apiGenerate(payload)  → { ok, yaml? , script? }   // 生成
```

- **`transport-web.js`**（verge-plugin 网页用）：内部即现有 `fetch('/api/...')`，行为零变化。
- **`transport-ext.js`**（verge-extension 用）：本地直调核心 + 扩展能力。
- esbuild 用 **import 别名**在构建时把 `app.js` 的 `import ... from './transport'` 指向对应实现。

### 4.4 扩展专属组件（verge-extension）

- **`manifest.json`（MV3）** 要点：
  ```jsonc
  {
    "manifest_version": 3,
    "name": "Clash Verge 覆写生成器",
    "action": { "default_title": "打开覆写生成器" },     // 不设 popup
    "background": { "service_worker": "background.js" },
    "permissions": ["declarativeNetRequestWithHostAccess"],
    "optional_host_permissions": ["*://*/*"],            // 运行时按域申请，不在安装时要全域
    "content_security_policy": {
      "extension_pages": "script-src 'self'; object-src 'self'"  // 主页面严禁 eval
    },
    "icons": { "16": "...", "48": "...", "128": "..." }
  }
  ```
  > 已无 `sandbox` 页、无 `unsafe-eval`（hook 去掉的直接收益）。
- **`background.js`**：监听 `chrome.action.onClicked` → `chrome.tabs.create({ url: chrome.runtime.getURL('ui/index.html') })`。
- **`transport-ext.js`**：实现 §5 数据流。

---

## 5. 数据流（扩展端，端到端）

```
点图标 → background.js 开 ui/index.html 标签页
  │
  ├─[拉取] → transport-ext.apiFetch(url)
  │     ① chrome.permissions.request({origins:[该域]})  按域授权（用户手势）
  │     ② 注册临时 DNR 会话规则：condition urlFilter="|<该URL>" resourceTypes=["xmlhttprequest"]
  │                              action modifyHeaders → set User-Agent="clash-verge/1.5.0"
  │     ③ fetch(url)
  │     ④ finally 移除该 DNR 规则
  │     ⑤ tryDecodeSubscription → yaml.load 校验 → summarize → 回填节点列表
  │
  ├─[上传/粘贴 YAML] → transport-ext.apiParse(text) → 本地 decodeBase64 + load + summarize
  │
  └─[生成] → transport-ext.apiGenerate(payload)
        ├ 目标引用完整性校验 + dialer-proxy 死循环防御（核心内，本地抛错）
        ├ format=script         → buildOverrideScript() → 返回脚本文本
        └ format=yaml/clashmi   → buildYaml()（同步，无 hook） → 返回 YAML
      → 预览栏展示 → 复制(clipboard API) / 下载(Blob)
```

全程除「拉订阅」一次出网到**用户自己的订阅服务器**外，无任何其它网络请求——这点写进隐私政策。

### 5.1 UA 改写为何不能直接用 fetch headers

`User-Agent` 是 fetch 的禁止头，写进 `headers` 会被浏览器忽略。故用 `declarativeNetRequestWithHostAccess` 的 `modifyHeaders` 规则改写——该变体只能改**已获 host 授权的域**，配合按域授权，scope 极窄，审核可接受。

---

## 6. 功能保留清单

| 模块 | 功能 | 状态 | 说明 |
|------|------|------|------|
| ① 输入订阅 | 订阅 URL 拉取 | 保留（机制变） | 后端代理 → 扩展本地 fetch + 按域授权 |
| | UA 伪装成 clash | 保留（机制变） | 后端改头 → `declarativeNetRequestWithHostAccess` |
| | 上传 YAML 文件 / 粘贴 YAML | 保留 | 本地解析 |
| | Base64 订阅自动解码 | 保留（机制变） | `Buffer` → 同构 `atob` |
| ② 中转+住宅 | 高速中转分组（select/url-test、全选/清空/仅专线/关键字过滤） | 保留 | |
| | 住宅静态 IP 录入（格式解析、socks5/http、前缀、分组、单/多行命名、`name\|`、`#` 注释、UDP、JSON 数组高级） | 保留 | |
| | 住宅自动挂 dialer-proxy 借道中转 | 保留 | |
| ②.5 | 直连住宅订阅（URL/粘贴、勾选注入） | 保留 | |
| ③ AI 出口 | 出口目标下拉、AI 总出口开关组 | 保留 | |
| | 内置 Claude 规则列表（DOMAIN/SUFFIX/KEYWORD/IP-CIDR/ASN、裸域默认 SUFFIX、修饰符保留） | 保留 | |
| | AI 规则集 rule-providers | 保留 | |
| DNS 防泄漏 | fake-ip + DoH + respect-rules + sniffer + fake-ip-filter | 保留 | |
| | └ LAN DNS 对外开放 / └ TUN 模式 + DNS 劫持 | 保留 | |
| 高级 | 特定端口代理入口（listeners + IN-PORT） | 保留 | |
| | **用户自定义扩展 Hook（main(params)）** | **去掉** | 唯一去掉项；YAML 执行版和脚本嵌入版都去掉 |
| ④ 生成 | JS 覆写脚本 / 完整 YAML / Export for ClashMi | 保留 | |
| | 生成 / 下载(Blob) / 复制(clipboard) / 选中节点统计 | 保留 | |
| ⑤ 预览 | 输出预览全文 | 保留 | |
| 校验 | 目标引用完整性校验、dialer-proxy 死循环防御 | 保留 | 移入核心 |

---

## 7. 错误处理

- **`apiFetch`**：用户拒绝按域授权 → 提示「需授权访问该订阅域名才能拉取」；upstream 非 200 / 解析失败 → 沿用现有 `/api/fetch` 文案；DNR 规则注册/移除放 **try/finally**，防规则泄漏污染其它请求；网络错误 → 友好提示。
- **`apiParse`**：解析失败 → 等价现有 422 提示。
- **`apiGenerate`**：目标引用完整性校验 + dialer-proxy 死循环防御 → 核心内本地抛错，UI 提示（与现有一致）。
- 扩展页面无 server，所有错误本地产生，复用现有 UI 错误展示位。

---

## 8. 测试

- **verge-core 仓**：现有 `test/generate.test.js`（node:test）随核心迁入，继续守核心；hook 用例注入 vm 版 `runHook`。核心同构，Node 下应全绿。
- **verge-extension 仓**：扩展专属部分（transport-ext、DNR 改 UA、按域授权）→ 针对性单测 + **load unpacked 手动冒烟**：拉真实订阅、生成 YAML、生成 script、ClashMi 导出各走一遍。可选 Playwright e2e。

---

## 9. 构建与分发

- `npm run build:ext` → esbuild 把「core(submodule) + js-yaml + transport-ext」打成 bundle，拷 `ui/ manifest.json background.js` 到 `dist/extension/`。
- 本地调试：chrome://extensions → 开发者模式 → 加载 `dist/extension/`。
- 上架：`dist/extension/` 打 zip → 开发者后台上传。manifest `version` 与 `package.json` 对齐。

---

## 10. 上架合规清单

1. **隐私政策**（必须）：声明「全部本地处理，除用户自己的订阅地址外不向任何服务器传输数据」；扩展处理订阅 URL + 住宅 IP 账号密码等敏感数据需说明。
2. **权限最小化**：`optional_host_permissions` 运行时按域申请，不在安装时要全域。
3. **UA 改写**：`declarativeNetRequestWithHostAccess` 窄 scope + 后台填用途说明（「拉取 Clash 订阅需 clash 兼容 UA」）。
4. **无动态代码执行**：hook 已去，不踩远程/动态代码红线。
5. **minify 不 obfuscate**：esbuild 压缩合规。
6. **单一用途说明** + 每条权限 justification。
7. **开发者账号**：一次性 $5，首审约几天。

---

## 11. 不在本设计范围（YAGNI）

- 与 Clash Verge 本地应用的深度联动（读当前标签页、自动触发等）——非当前目标。
- 自定义 Hook 的任何替代执行方案——已决定移除。
- Firefox / Edge 等其它浏览器适配——先聚焦 Chrome 上架。
