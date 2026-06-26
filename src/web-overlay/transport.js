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
