// Clash Verge 覆写生成器 - 本地服务入口
// 启动：npm install && npm start  (默认监听 http://127.0.0.1:7788)

const express = require("express");
const path = require("path");
const apiRouter = require("./routes/api");

const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || "127.0.0.1";

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.text({ type: ["text/plain", "text/yaml", "application/yaml", "application/x-yaml"], limit: "10mb" }));
// 覆盖层先注册：命中 /transport.js
app.use(express.static(path.join(__dirname, "web-overlay")));
// 再注册共享 UI 壳
app.use(express.static(path.join(__dirname, "..", "core", "web")));
app.use(apiRouter);

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`[verge-plugin] listening on http://${HOST}:${PORT}`);
  });
}

module.exports = app;
