// 同步协议 v2 行为测试：会话、推送去重/冲突、拉取游标、快照与整表重置。
// 每个用例独立启动服务实例，避免上一用例遗留的同步会话影响下一个用例。
import assert from "node:assert/strict";
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

test("协议版本不是 2 返回 426", async () => {
  await withApp(async (app) => {
    const res = await call(app.base, "POST", "/v1/sync/open", { body: { protocol: 1, device_id: "device-a" } });
    assert.equal(res.status, 426);
    assert.equal(res.json.error, "protocol_required");
  });
});

test("device_id 缺失返回 400", async () => {
  await withApp(async (app) => {
    const res = await call(app.base, "POST", "/v1/sync/open", { body: { protocol: 2, device_id: "  " } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_device");
  });
});

test("另一台设备并发同步返回 409 sync_locked", async () => {
  await withApp(async (app) => {
    const first = await openSession(app.base, "lock-a");
    const blocked = await call(app.base, "POST", "/v1/sync/open", { body: { protocol: 2, device_id: "lock-b" } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error, "sync_locked");
    assert.ok(blocked.json.retry_after_ms > 0);
    await call(app.base, "POST", "/v1/sync/close", { body: { session_id: first.session_id, device_id: "lock-a", success: false } });
    const again = await openSession(app.base, "lock-b");
    assert.ok(again.session_id);
  });
});

test("push 校验、去重、冲突与 equal 判定", async () => {
  await withApp(async (app) => {
    const session = await openSession(app.base, "push-a");
    const sid = session.session_id;
    const push = (changes) => call(app.base, "POST", "/v1/sync/push", { body: { session_id: sid, device_id: "push-a", client_epoch: "epoch-1", changes } });

    const first = await push([{ table_name: "note", row_id: "n1", client_seq: 1, op: "upsert", updated_at: 1000, payload: { id: "n1", title: "第一条", updated_at: 1000 } }]);
    assert.equal(first.status, 200);
    assert.equal(first.json.results[0].status, "accepted");
    assert.equal(first.json.accepted_up_to, 1);

    const duplicate = await push([{ table_name: "note", row_id: "n1", client_seq: 1, op: "upsert", updated_at: 1000, payload: { id: "n1", title: "改过", updated_at: 1000 } }]);
    assert.equal(duplicate.json.results[0].status, "duplicate");
    assert.equal(duplicate.json.results[0].current.title, "第一条");

    const conflict = await push([{ table_name: "note", row_id: "n1", client_seq: 2, op: "upsert", updated_at: 500, payload: { id: "n1", title: "旧", updated_at: 500 } }]);
    assert.equal(conflict.json.results[0].status, "conflict");
    assert.equal(conflict.json.results[0].current.title, "第一条");

    const equal = await push([{ table_name: "note", row_id: "n1", client_seq: 3, op: "upsert", updated_at: 1000, payload: { title: "第一条", id: "n1", updated_at: 1000 } }]);
    assert.equal(equal.json.results[0].status, "equal");

    const invalid = await push([
      { table_name: "note", row_id: "n2", client_seq: 4, op: "upsert", updated_at: 1000, payload: { id: "别的 id", updated_at: 1000 } },
      { table_name: "note", row_id: "n3", client_seq: 5, op: "remove", updated_at: 1000, payload: { id: "n3", updated_at: 1000 } },
    ]);
    assert.equal(invalid.json.results[0].status, "invalid");
    assert.equal(invalid.json.results[1].status, "invalid");
    assert.equal(invalid.json.accepted_up_to, 5);
  });
});

test("pull 按游标返回变更并推进 next_cursors", async () => {
  await withApp(async (app) => {
    const session = await openSession(app.base, "pull-a");
    const sid = session.session_id;
    await call(app.base, "POST", "/v1/sync/push", {
      body: {
        session_id: sid,
        device_id: "pull-a",
        client_epoch: "epoch-pull",
        changes: [{ table_name: "note", row_id: "p1", client_seq: 1, op: "upsert", updated_at: 2000, payload: { id: "p1", updated_at: 2000 } }],
      },
    });
    const pulled = await call(app.base, "POST", "/v1/sync/pull", { body: { session_id: sid, device_id: "pull-a", cursors: { note: 0 }, limit: 10 } });
    assert.equal(pulled.status, 200);
    const entry = pulled.json.entries.find((e) => e.row_id === "p1");
    assert.ok(entry);
    assert.equal(entry.op, "upsert");
    assert.equal(pulled.json.next_cursors.note, entry.server_seq);
    const pulledAgain = await call(app.base, "POST", "/v1/sync/pull", {
      body: { session_id: sid, device_id: "pull-a", cursors: pulled.json.next_cursors, limit: 10 },
    });
    assert.equal(pulledAgain.json.entries.length, 0);
    const closed = await call(app.base, "POST", "/v1/sync/close", {
      body: { session_id: sid, device_id: "pull-a", success: true, cursors: pulled.json.next_cursors },
    });
    assert.equal(closed.status, 200);
    const me = await call(app.base, "GET", "/v1/me");
    assert.ok(me.json.devices.some((d) => d.id === "pull-a" && d.last_sync_at !== null));
  });
});

test("snapshot 返回行与版本，full 版本冲突后能重置", async () => {
  await withApp(async (app) => {
    const session = await openSession(app.base, "snap-a");
    const sid = session.session_id;
    const body = { session_id: sid, device_id: "snap-a" };

    const empty = await call(app.base, "POST", "/v1/sync/snapshot", { body: { ...body, table: "note" } });
    assert.equal(empty.status, 200);
    assert.equal(empty.json.version, 0);
    assert.equal(empty.json.mode, "row");

    const version = empty.json.version;
    const ok = await call(app.base, "POST", "/v1/sync/full", {
      body: { ...body, table: "note", base_version: version, rows: [{ id: "f1", updated_at: 3000, title: "整表" }] },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.version, version + 1);

    const stale = await call(app.base, "POST", "/v1/sync/full", {
      body: { ...body, table: "note", base_version: version, rows: [] },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, "version_conflict");

    const snap = await call(app.base, "POST", "/v1/sync/snapshot", { body: { ...body, table: "note" } });
    assert.equal(snap.json.rows.length, 1);
    assert.equal(snap.json.mode, "tree");
  });
});

test("会话不匹配或过期返回 401", async () => {
  await withApp(async (app) => {
    const session = await openSession(app.base, "sess-a");
    const wrong = await call(app.base, "POST", "/v1/sync/pull", {
      body: { session_id: session.session_id, device_id: "other-device", cursors: {} },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, "session_device_mismatch");
    const bogus = await call(app.base, "POST", "/v1/sync/pull", { body: { session_id: "not-a-session", device_id: "sess-a", cursors: {} } });
    assert.equal(bogus.status, 401);
    assert.equal(bogus.json.error, "session_not_found");
  });
});
