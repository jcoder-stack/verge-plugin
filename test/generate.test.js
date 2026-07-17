const { test, before, after } = require("node:test");
const assert = require("node:assert");
const yaml = require("js-yaml");
const app = require("../src/server");

let server, base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

async function post(pathname, body, asText) {
  const r = await fetch(base + pathname, {
    method: "POST",
    headers: { "Content-Type": asText ? "text/plain" : "application/json" },
    body: asText ? body : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

function generate(body) {
  return post("/api/generate", body);
}

// 测试用直连住宅节点（vless + reality，带嵌套字段）
const DIRECT_NODE = {
  name: "【B41-BISP4】美国ATT住宅 12.12.127.126",
  type: "vless",
  server: "bisp4.resip.cc",
  port: 36041,
  uuid: "0430e547-7b1b-4410-a0d7-df4ef066c44b",
  tls: true,
  flow: "xtls-rprx-vision",
  servername: "steamcdn-a.akamaihd.net",
  "client-fingerprint": "chrome",
  "reality-opts": { "public-key": "OTjSIZonl1n", "short-id": "b76c181224d839ee" },
};

function baseYaml() {
  return yaml.dump({
    proxies: [{ name: "vps1", type: "ss", server: "1.2.3.4", port: 443 }],
    "proxy-groups": [],
    rules: [],
  });
}

test("/api/parse 返回 proxiesFull（含完整字段）", async () => {
  const { status, json } = await post(
    "/api/parse",
    yaml.dump({ proxies: [DIRECT_NODE] }),
    true
  );
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.summary.proxiesFull), "summary.proxiesFull 是数组");
  const p = json.summary.proxiesFull[0];
  assert.equal(p.name, DIRECT_NODE.name);
  assert.deepEqual(p["reality-opts"], DIRECT_NODE["reality-opts"]);
});

test("directResidentials 注入 proxies 且不挂 dialer-proxy，建 select 分组", async () => {
  const { status, json } = await generate({
    yaml: baseYaml(),
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    format: "yaml",
  });
  assert.equal(status, 200);
  const out = yaml.load(json.yaml);
  const injected = out.proxies.find((p) => p.name === DIRECT_NODE.name);
  assert.ok(injected, "节点已注入");
  assert.equal(injected["dialer-proxy"], undefined, "不应有 dialer-proxy");
  assert.deepEqual(injected["reality-opts"], DIRECT_NODE["reality-opts"], "字段原样保留");
  const group = out["proxy-groups"].find((g) => g.name === "直连住宅");
  assert.ok(group, "建了直连住宅分组");
  assert.equal(group.type, "select");
  assert.deepEqual(group.proxies, [DIRECT_NODE.name]);
});

test("AI 出口目标填直连住宅分组名 → 校验通过并生成规则", async () => {
  const { status, json } = await generate({
    yaml: baseYaml(),
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    aiRules: { target: "直连住宅", domains: ["DOMAIN-SUFFIX,anthropic.com"], providers: [] },
    format: "yaml",
  });
  assert.equal(status, 200, json.error || "");
  assert.ok(json.yaml.includes("DOMAIN-SUFFIX,anthropic.com,直连住宅"));
});

test("端口映射目标填直连住宅节点名 → 校验通过并生成 IN-PORT", async () => {
  const { status, json } = await generate({
    yaml: baseYaml(),
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    portMappings: [{ port: 1080, type: "socks", target: DIRECT_NODE.name }],
    format: "yaml",
  });
  assert.equal(status, 200, json.error || "");
  assert.ok(json.yaml.includes("IN-PORT,1080," + DIRECT_NODE.name));
});

test("script 输出内联 DIRECT_RESIDENTIALS 与分组名", async () => {
  const { status, json } = await generate({
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    format: "script",
  });
  assert.equal(status, 200, json.error || "");
  assert.equal(json.format, "script");
  assert.match(json.script, /const DIRECT_RESIDENTIALS = /);
  assert.match(json.script, /const DIRECT_RESIDENTIAL_GROUP = /);
  assert.ok(json.script.includes("reality-opts"), "节点完整字段被内联");
  assert.ok(json.script.includes("直连住宅"), "分组名被内联");
});

test("script 生成的 main() 运行时注入直连住宅、不挂 dialer-proxy、建分组", async () => {
  const { status, json } = await generate({
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    format: "script",
  });
  assert.equal(status, 200, json.error || "");
  assert.ok(json.ok);
  // 在测试进程内执行生成脚本，取出 main 并对 mock params 运行
  const main = new Function(json.script + "\n;return main;")();
  const out = main({ proxies: [], "proxy-groups": [], rules: [] });
  const injected = out.proxies.find((p) => p.name === DIRECT_NODE.name);
  assert.ok(injected, "节点已注入");
  assert.equal(injected["dialer-proxy"], undefined, "不应有 dialer-proxy");
  assert.deepEqual(injected["reality-opts"], DIRECT_NODE["reality-opts"]);
  const group = out["proxy-groups"].find((g) => g.name === "直连住宅");
  assert.ok(group, "建了直连住宅分组");
  assert.equal(group.type, "select");
  assert.deepEqual(group.proxies, [DIRECT_NODE.name]);
});

test("只用直连住宅、不传 relay → 仍能生成 YAML", async () => {
  const { status, json } = await generate({
    yaml: baseYaml(),
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    format: "yaml",
  });
  assert.equal(status, 200, json.error || "");
  const out = yaml.load(json.yaml);
  assert.ok(out.proxies.find((p) => p.name === DIRECT_NODE.name));
  assert.ok(out["proxy-groups"].find((g) => g.name === "直连住宅"));
});

test("aiExitGroup 创建 AI 总出口组（直连优先），AI 指向它", async () => {
  const { status, json } = await generate({
    yaml: baseYaml(),
    relay: { name: "高速中转", type: "select", proxies: ["vps1"] },
    residentials: [{ name: "住宅-1", type: "socks5", server: "h", port: 1, username: "u", password: "p" }],
    residentialGroup: "住宅节点",
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    aiExitGroup: "AI 总出口",
    aiRules: { target: "AI 总出口", domains: ["DOMAIN-SUFFIX,anthropic.com"], providers: [] },
    format: "yaml",
  });
  assert.equal(status, 200, json.error || "");
  const out = yaml.load(json.yaml);
  const g = out["proxy-groups"].find((x) => x.name === "AI 总出口");
  assert.ok(g, "总出口组存在");
  assert.equal(g.type, "select");
  assert.deepEqual(g.proxies, ["直连住宅", "住宅节点"], "直连组在前、中转组在后");
  assert.ok(json.yaml.includes("DOMAIN-SUFFIX,anthropic.com,AI 总出口"));
});

test("aiExitGroup 只有直连住宅时，成员只含直连组", async () => {
  const { status, json } = await generate({
    yaml: baseYaml(),
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    aiExitGroup: "AI 总出口",
    format: "yaml",
  });
  assert.equal(status, 200, json.error || "");
  const out = yaml.load(json.yaml);
  const g = out["proxy-groups"].find((x) => x.name === "AI 总出口");
  assert.ok(g);
  assert.deepEqual(g.proxies, ["直连住宅"]);
});

test("script: aiExitGroup 运行时创建总出口组（直连+中转）", async () => {
  const { status, json } = await generate({
    relay: { name: "高速中转", type: "select", proxies: ["x"] },
    residentials: [{ name: "住宅-1", type: "socks5", server: "h", port: 1, username: "u", password: "p" }],
    residentialGroup: "住宅节点",
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    aiExitGroup: "AI 总出口",
    format: "script",
  });
  assert.equal(status, 200, json.error || "");
  assert.match(json.script, /const AI_EXIT_GROUP = /);
  const main = new Function(json.script + "\n;return main;")();
  const out = main({ proxies: [], "proxy-groups": [], rules: [] });
  const g = out["proxy-groups"].find((x) => x.name === "AI 总出口");
  assert.ok(g, "总出口组运行时已建");
  assert.deepEqual(g.proxies, ["直连住宅", "住宅节点"]);
});

test("AI 规则顺序：RULE-SET（规则集 URL）在前，DOMAIN 在后", async () => {
  const { status, json } = await generate({
    yaml: baseYaml(),
    directResidentials: [DIRECT_NODE],
    directResidentialGroup: "直连住宅",
    aiRules: {
      target: "直连住宅",
      domains: ["DOMAIN-SUFFIX,anthropic.com"],
      providers: [{ name: "AI_No_Resolve", url: "https://example.com/ai.yaml", behavior: "classical", interval: 259200 }],
    },
    format: "yaml",
  });
  assert.equal(status, 200, json.error || "");
  const rsIdx = json.yaml.indexOf("RULE-SET,AI_No_Resolve,直连住宅");
  const domIdx = json.yaml.indexOf("DOMAIN-SUFFIX,anthropic.com,直连住宅");
  assert.ok(rsIdx >= 0, "应有 RULE-SET");
  assert.ok(domIdx >= 0, "应有 DOMAIN-SUFFIX");
  assert.ok(rsIdx < domIdx, "RULE-SET 应在 DOMAIN 之前");
});

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
