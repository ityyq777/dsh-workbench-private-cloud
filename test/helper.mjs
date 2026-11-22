// 测试夹具：临时数据目录 + 随机端口启动真实 HTTP 服务。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";

export const SECRET = "test-secret-0123456789abcdef";

export async function startServer(env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wb-private-cloud-"));
  const config = loadConfig({
    WB_PRIVATE_SECRET: SECRET,
    WB_PRIVATE_DATA: dir,
    WB_PRIVATE_SESSION_TTL_SECONDS: "300",
    ...env,
  });
  const db = openDb(config.dataDir);
  const server = createApp({ db, config, log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    base,
    db,
    dir,
    config,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function call(base, method, route, { body, token = SECRET, headers = {}, binary = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = "Bearer " + token;
  if (body !== undefined) {
    if (binary) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers["content-type"] = "application/json";
    }
  }
  const res = await fetch(base + route, init);
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch {
    /* 二进制响应 */
  }
  return { status: res.status, json, buffer: buf, headers: res.headers };
}

/** 打开一个同步会话并返回 { session_id, device_id }。 */
export async function openSession(base, deviceId = "device-a", extra = {}) {
  const res = await call(base, "POST", "/v1/sync/open", { body: { protocol: 2, device_id: deviceId, ...extra } });
  if (res.status !== 200) throw new Error("open 失败：" + res.status + " " + JSON.stringify(res.json));
  return { session_id: res.json.session_id, device_id: deviceId, expires_at: res.json.expires_at };
}
