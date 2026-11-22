// 数据清空：确认词校验、数据/设备/文件清空、实例身份保留、清空后可重新同步。
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { call, openSession, startServer } from "./helper.mjs";

async function withApp(fn) {
  const app = await startServer();
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

/** 造一些真实数据：一条同步变更、一个 blob 文件、一个设备记录。 */
async function seed(app) {
  const session = await openSession(app.base, "clear-a");
  const push = await call(app.base, "POST", "/v1/sync/push", {
    body: {
      session_id: session.session_id,
      device_id: "clear-a",
      client_epoch: "epoch-clear",
      changes: [{ table_name: "note", row_id: "n1", client_seq: 1, op: "upsert", updated_at: 1000, payload: { id: "n1", title: "待清空", updated_at: 1000 } }],
    },
  });
  assert.equal(push.status, 200);
  await call(app.base, "POST", "/v1/sync/close", { body: { session_id: session.session_id, device_id: "clear-a", success: true } });

  const sha = "a".repeat(64);
  app.db.prepare("INSERT INTO blobs(sha256, size, mime, state, created_at, verified_at, last_access_at) VALUES(?,?,?,'ready',?,?,?)").run(sha, 5, "text/plain", 1, 1, 1);
  const dir = path.join(app.dir, "blobs", sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, sha), "hello");
  return sha;
}

function metaKeys(db) {
  return db.prepare("SELECT k FROM meta ORDER BY k").all().map((r) => r.k);
}

test("确认词不对时拒绝清空", async () => {
  await withApp(async (app) => {
    await seed(app);
    const res = await call(app.base, "POST", "/v1/admin/clear", { body: { confirm: "清空" } });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, "confirm_required");
    assert.equal(res.json.confirm, "清空云端数据");
    const stats = await call(app.base, "GET", "/v1/stats");
    assert.equal(stats.json.changes.total, 1);
  });
});

test("未带密钥不能清空", async () => {
  await withApp(async (app) => {
    await seed(app);
    const res = await call(app.base, "POST", "/v1/admin/clear", { body: { confirm: "清空云端数据" }, token: null });
    assert.equal(res.status, 401);
    const stats = await call(app.base, "GET", "/v1/stats");
    assert.equal(stats.json.changes.total, 1);
  });
});

test("清空后业务数据、设备与文件都归零，实例身份保留", async () => {
  await withApp(async (app) => {
    const sha = await seed(app);
    const instanceId = app.db.prepare("SELECT v FROM meta WHERE k = 'instance_id'").get().v;
    assert.ok(instanceId);

    const res = await call(app.base, "POST", "/v1/admin/clear", { body: { confirm: "清空云端数据" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(res.json.rows >= 3, "至少清掉设备、变更与行状态");
    assert.equal(res.json.blobs, 1);

    const stats = await call(app.base, "GET", "/v1/stats");
    assert.equal(stats.json.changes.total, 0);
    assert.equal(stats.json.tables.length, 0);
    assert.equal(stats.json.devices.length, 0);
    assert.equal(stats.json.session, null);
    assert.equal(stats.json.usage.blob_count, 0);

    // 文件目录被删空；实例身份与清空时间留在 meta。
    assert.deepEqual(readdirSync(path.join(app.dir, "blobs")), []);
    assert.equal(app.db.prepare("SELECT v FROM meta WHERE k = 'instance_id'").get().v, instanceId);
    assert.deepEqual(metaKeys(app.db), ["instance_id", "last_clear_at"]);
    assert.ok(app.db.prepare("SELECT 1 FROM blobs WHERE sha256 = ?").get(sha) === undefined);

    // 清空后健康检查照常，设备可以重新打开同步会话。
    const health = await call(app.base, "GET", "/v1/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    const again = await openSession(app.base, "clear-b");
    assert.ok(again.session_id);
  });
});

test("重复清空是幂等的", async () => {
  await withApp(async (app) => {
    const body = { confirm: "清空云端数据" };
    const first = await call(app.base, "POST", "/v1/admin/clear", { body });
    assert.equal(first.status, 200);
    const second = await call(app.base, "POST", "/v1/admin/clear", { body });
    assert.equal(second.status, 200);
    assert.equal(second.json.rows, 0);
    assert.equal(second.json.blobs, 0);
  });
});
