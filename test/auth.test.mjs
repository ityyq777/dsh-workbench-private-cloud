// 鉴权与基础接口测试。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SECRET, call, startServer } from "./helper.mjs";

let app;
before(async () => {
  app = await startServer();
});
after(async () => {
  await app.close();
});

test("健康检查不需要密钥，且不泄露密钥", async () => {
  const res = await call(app.base, "GET", "/v1/health", { token: "" });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.mode, "private");
  assert.equal(res.json.protocol, 2);
  assert.ok(!JSON.stringify(res.json).includes(SECRET));
});

test("缺少或错误的密钥返回 401", async () => {
  const anon = await call(app.base, "GET", "/v1/me", { token: "" });
  assert.equal(anon.status, 401);
  const wrong = await call(app.base, "GET", "/v1/me", { token: "wrong-secret-value-1234" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, "unauthorized");
});

test("正确密钥返回单用户信息与文件配额", async () => {
  const res = await call(app.base, "GET", "/v1/me");
  assert.equal(res.status, 200);
  assert.equal(res.json.user.id, "private-owner");
  assert.equal(res.json.user.name, "我的私人云端");
  assert.ok(Array.isArray(res.json.devices));
  assert.equal(res.json.quota.quota_bytes, app.config.quotaBytes);
});

test("连续错误密钥会被限流", async () => {
  const ipApp = await startServer();
  try {
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await call(ipApp.base, "GET", "/v1/me", { token: "bad-secret-" + i });
    }
    assert.equal(last.status, 429);
    assert.equal(last.json.error, "too_many_attempts");
    assert.ok(Number(last.headers.get("retry-after")) > 0);
  } finally {
    await ipApp.close();
  }
});
