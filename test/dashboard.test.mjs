// 概览页与统计接口：页面是静态外壳，数据必须经 /v1/stats 且要求密钥。
import assert from "node:assert/strict";
import { test } from "node:test";
import { SECRET, call, openSession, startServer } from "./helper.mjs";

async function withApp(fn) {
  const app = await startServer();
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test("浏览器请求根路径返回概览页，脚本请求仍返回 JSON", async () => {
  await withApp(async (app) => {
    const page = await call(app.base, "GET", "/", { headers: { accept: "text/html" } });
    assert.equal(page.status, 200);
    assert.match(String(page.headers.get("content-type")), /text\/html/);
    const html = page.buffer.toString("utf8");
    assert.match(html, /私人云端/);
    assert.match(html, /\/v1\/stats/);
    // 页面里绝不能内联密钥。
    assert.equal(html.includes(SECRET), false);

    const json = await call(app.base, "GET", "/");
    assert.equal(json.status, 200);
    assert.equal(json.json.mode, "private");
    assert.ok(Array.isArray(json.json.endpoints));
  });
});

test("/v1/stats 需要密钥", async () => {
  await withApp(async (app) => {
    const res = await call(app.base, "GET", "/v1/stats", { token: "" });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, "unauthorized");
  });
});

test("/v1/stats 汇总设备、数据表与变更", async () => {
  await withApp(async (app) => {
    const session = await openSession(app.base, "stats-a", { device_name: "统计设备" });
    await call(app.base, "POST", "/v1/sync/push", {
      body: {
        session_id: session.session_id,
        device_id: "stats-a",
        client_epoch: "e1",
        changes: [
          { table_name: "note", row_id: "n1", client_seq: 1, op: "upsert", updated_at: 1000, payload: { id: "n1", title: "甲", updated_at: 1000 } },
          { table_name: "note", row_id: "n2", client_seq: 2, op: "upsert", updated_at: 1001, payload: { id: "n2", title: "乙", updated_at: 1001 } },
        ],
      },
    });

    const res = await call(app.base, "GET", "/v1/stats", { token: SECRET });
    assert.equal(res.status, 200);
    const d = res.json;
    assert.equal(d.server.protocol, 2);
    assert.ok(d.server.uptime_s >= 0);
    assert.equal(d.devices.length, 1);
    assert.equal(d.devices[0].id, "stats-a");
    assert.equal(d.devices[0].name, "统计设备");
    assert.equal(d.devices[0].changes, 2);
    const note = d.tables.find((t) => t.table === "note");
    assert.ok(note, "应当出现 note 表");
    assert.equal(note.rows, 2);
    assert.equal(note.deleted, 0);
    assert.equal(d.changes.total, 2);
    assert.equal(d.changes.max_seq, 2);
    assert.equal(d.session.device_id, "stats-a");
    assert.equal(d.session.active, true);
    assert.equal(d.usage.quota_bytes > 0, true);
    assert.equal(d.usage.blob_count, 0);
  });
});
