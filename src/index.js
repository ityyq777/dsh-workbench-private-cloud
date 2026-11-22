#!/usr/bin/env node
// 私人云端入口：读取环境变量、打开 SQLite、启动 HTTP 服务。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./env-file.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createApp } from "./server.js";

function main() {
  // 先看当前目录的 .env（`node src/index.js` 与 `npm start` 都落在仓库根），再按需读入口同级目录。
  const here = path.dirname(fileURLToPath(import.meta.url));
  loadEnvFile(process.cwd());
  loadEnvFile(path.join(here, ".."));
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(1);
  }
  const db = openDb(config.dataDir);
  const server = createApp({
    db,
    config,
    log: (...args) => console.error(new Date().toISOString(), ...args),
  });

  server.listen(config.port, config.host, () => {
    const shown = config.host === "0.0.0.0" ? "本机所有网卡" : config.host;
    console.log("DSH Workbench 私人云端已启动");
    console.log("  监听：" + config.host + ":" + config.port + "（" + shown + "）");
    console.log("  数据：" + config.dataDir);
    console.log("  名称：" + config.serverName);
    console.log("  单文件上限：" + Math.round(config.maxFileBytes / 1024 / 1024) + " MB，配额：" + Math.round(config.quotaBytes / 1024 / 1024 / 1024) + " GB");
    if (config.host !== "127.0.0.1" && config.host !== "::1") {
      console.log("提示：对外暴露时请放在 HTTPS 反向代理之后，访问密钥以明文 Bearer 传输前必须加密。");
    }
  });

  const shutdown = (signal) => {
    console.log("收到 " + signal + "，正在关闭…");
    server.close(() => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
