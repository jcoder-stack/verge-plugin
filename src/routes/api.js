// HTTP 接口：/api/fetch（拉取订阅）/ /api/parse（解析）/ /api/generate（生成覆写）

const express = require("express");
const yaml = require("js-yaml");
const vm = require("vm");
const { tryDecodeSubscription, summarize, buildYaml, buildOverrideScript, resolveAIRules } = require("../../core");

function vmRunHook(script, params) {
  const sandbox = { params, module: { exports: {} }, exports: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(
    `${script}\n;if (typeof main === 'function') { params = main(params) || params; }`,
    sandbox, { timeout: 3000 }
  );
  return sandbox.params;
}

const router = express.Router();

// ------------------------------------------------------------------
// POST /api/fetch  { url }  → 拉取订阅，返回原始 YAML 文本（绕过浏览器 CORS）
// ------------------------------------------------------------------
router.post("/api/fetch", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "missing url" });
  }
  try {
    const r = await fetch(url, {
      headers: {
        // 多数订阅需要 clash 标识才返回 YAML
        "User-Agent": "clash-verge/1.5.0",
      },
      redirect: "follow",
    });
    if (!r.ok) {
      return res.status(502).json({ error: `upstream ${r.status} ${r.statusText}` });
    }
    const text = await r.text();
    const yamlText = tryDecodeSubscription(text);
    // 尝试解析看是否合法
    let parsed;
    try {
      parsed = yaml.load(yamlText);
    } catch (e) {
      return res.status(422).json({ error: `parse failed: ${e.message}`, raw: yamlText.slice(0, 500) });
    }
    return res.json({ ok: true, yaml: yamlText, summary: summarize(parsed) });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ------------------------------------------------------------------
// POST /api/parse  body: YAML 文本   → 返回 { summary, yaml }
// ------------------------------------------------------------------
router.post("/api/parse", (req, res) => {
  const text = typeof req.body === "string" ? req.body : req.body?.yaml || "";
  const yamlText = tryDecodeSubscription(text);
  try {
    const parsed = yaml.load(yamlText);
    return res.json({ ok: true, yaml: yamlText, summary: summarize(parsed) });
  } catch (e) {
    return res.status(422).json({ error: `parse failed: ${e.message}` });
  }
});

// ------------------------------------------------------------------
// POST /api/generate
//   body: { yaml, format, relay, residentials, residentialGroup,
//           directResidentials, directResidentialGroup, aiExitGroup,
//           aiRules, dnsAntiLeak, dnsLan, dnsTun, portMappings, extensionScript }
//   → format=script → { ok, format, script, notices }
//     format=yaml/clashmi → { ok, yaml, notices }
// ------------------------------------------------------------------
router.post("/api/generate", (req, res) => {
  const { yaml: srcYaml, relay, residentials, directResidentials, portMappings, aiRules, dnsAntiLeak, dnsLan, dnsTun, extensionScript, format } = req.body || {};
  const outputFormat =
    format === "script" ? "script" : format === "clashmi" ? "clashmi" : "yaml";
  // 住宅节点 select 分组名：来自用户输入，缺省回退 "住宅节点"
  const residentialGroup =
    (typeof req.body?.residentialGroup === "string" && req.body.residentialGroup.trim()) || "住宅节点";
  // 直连住宅 select 分组名：来自用户输入，缺省回退 "直连住宅"
  const directResidentialGroup =
    (typeof req.body?.directResidentialGroup === "string" && req.body.directResidentialGroup.trim()) || "直连住宅";
  // AI 总出口开关组名：启用时为非空字符串（包含 直连住宅 + 住宅节点 两个出口组，供 AI 规则在客户端一键切直连/中转）
  const aiExitGroup =
    (typeof req.body?.aiExitGroup === "string" && req.body.aiExitGroup.trim()) || "";
  // 总出口组成员：实际会存在的出口分组（直连优先），仅在有成员时才创建/注册
  const aiExitMembers = [];
  if (Array.isArray(directResidentials) && directResidentials.some((r) => r && r.name)) aiExitMembers.push(directResidentialGroup);
  if (Array.isArray(residentials) && residentials.some((r) => r && r.name)) aiExitMembers.push(residentialGroup);

  // AI 出口目标回退链：在此解析，与 verge-extension 的 localGenerate 共用同一实现。
  // 无可用目标 → 不写入 AI 规则、不阻断生成，转成 notices 提示。
  const { aiRules: resolvedAIRules, skipped: aiSkipped } = resolveAIRules({
    aiRules, aiExitGroup, residentialGroup, directResidentialGroup, residentials, directResidentials,
  });
  const notices = aiSkipped ? ["AI 规则未写入：未配置任何住宅出口（直连住宅或中转住宅）"] : [];

  // 目标引用完整性校验：AI target / port target 必须能解析成 订阅节点/分组/中转组/将要新增的住宅节点 之一
  {
    const knownNames = new Set();
    if (relay && relay.name) knownNames.add(relay.name);
    if (Array.isArray(residentials)) {
      residentials.forEach((n) => { if (n && n.name) knownNames.add(n.name); });
    }
    // 住宅节点分组（自动生成，分组名由用户定义）
    if (Array.isArray(residentials) && residentials.some((r) => r && r.name)) knownNames.add(residentialGroup);
    if (Array.isArray(directResidentials)) {
      directResidentials.forEach((n) => { if (n && n.name) knownNames.add(n.name); });
    }
    if (Array.isArray(directResidentials) && directResidentials.some((r) => r && r.name)) knownNames.add(directResidentialGroup);
    // AI 总出口开关组（仅当有成员组时才会真正创建，故有成员时才注册为合法目标）
    if (aiExitGroup && aiExitMembers.length > 0) knownNames.add(aiExitGroup);
    // 订阅里已有的节点/分组（只在 YAML 路径能解析出来；Script 路径无法校验订阅端节点）
    if (srcYaml && typeof srcYaml === "string") {
      try {
        const p = yaml.load(srcYaml);
        if (p && Array.isArray(p.proxies)) p.proxies.forEach((x) => { if (x && x.name) knownNames.add(x.name); });
        if (p && Array.isArray(p["proxy-groups"])) p["proxy-groups"].forEach((x) => { if (x && x.name) knownNames.add(x.name); });
      } catch {}
    }
    const missing = [];
    if (resolvedAIRules && resolvedAIRules.target && knownNames.size > 0 && !knownNames.has(resolvedAIRules.target)) {
      if (!srcYaml) {
        // Script 路径：只校验中转组/住宅节点，无法校验订阅端，所以只警告，不拦截
      } else {
        missing.push(`AI 出口目标 "${resolvedAIRules.target}"`);
      }
    }
    if (Array.isArray(portMappings) && srcYaml) {
      portMappings.forEach((m) => {
        if (m && m.target && !knownNames.has(m.target)) missing.push(`端口 ${m.port} 的目标 "${m.target}"`);
      });
    }
    if (missing.length > 0) {
      return res.status(400).json({
        error:
          `以下目标节点在订阅/中转组/住宅节点中都找不到，生成的配置无法引用，请修正：\n  - ${missing.join("\n  - ")}\n` +
          `提示：住宅节点默认名=「名称前缀」（单行时）或「前缀-序号」（多行时），可在行首加 "name|" 显式指定。`,
      });
    }
  }

  // 死循环防御（两种输出都需要检查）
  if (relay && Array.isArray(relay.proxies) && Array.isArray(residentials)) {
    const residentialNames = new Set(residentials.filter((r) => r && r.name).map((r) => r.name));
    const conflict = relay.proxies.filter((n) => residentialNames.has(n));
    if (conflict.length > 0) {
      return res.status(400).json({
        error: `中转组候选包含住宅节点名 [${conflict.join(", ")}]，会导致 dialer-proxy 死循环，请移除`,
      });
    }
  }

  // ===== 输出 JS 覆写脚本 =====
  if (outputFormat === "script") {
    try {
      const script = buildOverrideScript({ relay, residentials, residentialGroup, directResidentials, directResidentialGroup, aiExitGroup, portMappings, aiRules: resolvedAIRules, dnsAntiLeak, dnsLan, dnsTun, extensionScript });
      return res.json({ ok: true, format: "script", script, notices });
    } catch (e) {
      return res.status(500).json({ error: `build script failed: ${e.message}` });
    }
  }

  // ===== 输出 YAML / ClashMi YAML =====
  try {
    const outYaml = buildYaml({
      srcYaml, relay, residentials, residentialGroup, directResidentials, directResidentialGroup,
      aiExitGroup, aiRules: resolvedAIRules, dnsAntiLeak, dnsLan, dnsTun, portMappings, extensionScript, outputFormat,
    }, { runHook: vmRunHook });
    if (outputFormat === "clashmi") return res.json({ ok: true, format: "clashmi", yaml: outYaml, notices });
    return res.json({ ok: true, yaml: outYaml, notices });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
