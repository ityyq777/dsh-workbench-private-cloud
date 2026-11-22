// 文件接口测试：上传即 sha256 校验、去重、引用后才能下载、Range 与配额。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { call, openSession, startServer } from "./helper.mjs";

let app;
before(async () => {
  app = await startServer();
});
after(async () => {
  await app.close();
});

const bodyText = "私人云端文件接口测试内容\n".repeat(20);
const sha = createHash("sha256").update(Buffer.from(bodyText)).digest("hex");

test("上传后 check 能命中，未引用时下载返回 404", async () => {
  const put = await call(app.base, "PUT", "/v1/files/blobs/" + sha, {
    body: Buffer.from(bodyText),
    binary: true,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
  assert.equal(put.status, 201);
  assert.equal(put.json.sha256, sha);

  const dup = await call(app.base, "PUT", "/v1/files/blobs/" + sha, {
    body: Buffer.from(bodyText),
    binary: true,
    headers: { "content-type": "text/plain" },
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.deduped, true);

  const checked = await call(app.base, "POST", "/v1/files/check", { body: { hashes: [sha, "0".repeat(64)] } });
  assert.deepEqual(checked.json.have, [sha]);
  assert.deepEqual(checked.json.missing, ["0".repeat(64)]);

  const orphan = await call(app.base, "GET", "/v1/files/blobs/" + sha);
  assert.equal(orphan.status, 404);
  assert.equal(orphan.json.error, "blob_not_referenced");
});

test("同步 file 行建立引用后可以下载、支持 Range 与 HEAD", async () => {
  const session = await openSession(app.base, "files-a");
  const sid = session.session_id;
  const pushed = await call(app.base, "POST", "/v1/sync/push", {
    body: {
      session_id: sid,
      device_id: "files-a",
      client_epoch: "epoch-files",
      changes: [
        {
          table_name: "file",
          row_id: "file-1",
          client_seq: 1,
          op: "upsert",
          updated_at: 4000,
          payload: { id: "file-1", sha256: sha, name: "说明.txt", size: Buffer.byteLength(bodyText), mime: "text/plain", updated_at: 4000 },
        },
      ],
    },
  });
  assert.equal(pushed.json.results[0].status, "accepted");

  const full = await call(app.base, "GET", "/v1/files/blobs/" + sha);
  assert.equal(full.status, 200);
  assert.equal(full.buffer.toString("utf8"), bodyText);

  const ranged = await call(app.base, "GET", "/v1/files/blobs/" + sha, { headers: { range: "bytes=0-9" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.buffer.toString("utf8"), Buffer.from(bodyText).subarray(0, 10).toString("utf8"));

  const head = await call(app.base, "HEAD", "/v1/files/blobs/" + sha);
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(bodyText));

  const quota = await call(app.base, "GET", "/v1/files/quota");
  assert.equal(quota.json.used_bytes, Buffer.byteLength(bodyText));
  assert.equal(quota.json.blob_count, 1);

  await call(app.base, "POST", "/v1/sync/close", { body: { session_id: sid, device_id: "files-a", success: false } });
});

test("sha256 与内容不符返回 422，非法 sha 返回 400", async () => {
  const wrong = "a".repeat(64);
  const res = await call(app.base, "PUT", "/v1/files/blobs/" + wrong, { body: Buffer.from("内容不同"), binary: true });
  assert.equal(res.status, 422);
  assert.equal(res.json.error, "sha256_mismatch");
  const bad = await call(app.base, "PUT", "/v1/files/blobs/xyz", { body: Buffer.from("x"), binary: true });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "invalid_sha256");
});
