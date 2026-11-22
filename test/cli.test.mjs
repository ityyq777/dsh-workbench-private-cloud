// CLI：后台启停、状态、init 与端口/数据目录覆盖。
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/wb-private-cloud.mjs", import.meta.url));

function cli(args, env = {}, cwd = process.cwd()) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, cwd, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "wb-cli-"));
  const port = 21000 + Math.floor(Math.random() * 2000);
  const env = { WB_PRIVATE_SECRET: "cli-secret-0123456789abcdef", WB_PRIVATE_DATA: dir, WB_PRIVATE_PORT: String(port) };
  return { dir, env, port, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("status 在未运行时返回 3", async () => {
  const f = fixture();
  try {
    const r = await cli(["status"], f.env);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /未运行/);
  } finally {
    f.cleanup();
  }
});

test("start/status/restart/stop 完整生命周期", async () => {
  const f = fixture();
  try {
    const started = await cli(["start"], f.env);
    assert.equal(started.code, 0);
    assert.match(started.stdout, /已启动（PID \d+）/);
    assert.ok(existsSync(path.join(f.dir, "private-cloud.pid")));

    const status = await cli(["status"], f.env);
    assert.equal(status.code, 0);
    assert.match(status.stdout, /运行中/);
    assert.match(status.stdout, /我的私人云端/);

    const again = await cli(["start"], f.env);
    assert.equal(again.code, 1);
    assert.match(again.stdout, /已在运行/);

    const restarted = await cli(["restart"], f.env);
    assert.equal(restarted.code, 0);
    assert.match(restarted.stdout, /已停止/);
    assert.match(restarted.stdout, /已启动/);

    const health = await fetch("http://127.0.0.1:" + f.port + "/v1/health").then((r) => r.json());
    assert.equal(health.ok, true);

    const stopped = await cli(["stop"], f.env);
    assert.equal(stopped.code, 0);
    assert.match(stopped.stdout, /已停止/);
    assert.equal(existsSync(path.join(f.dir, "private-cloud.pid")), false);

    const after = await cli(["status"], f.env);
    assert.equal(after.code, 3);
  } finally {
    await cli(["stop"], f.env);
    f.cleanup();
  }
});

test("init 生成 .env 且不覆盖已有文件", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wb-cli-init-"));
  try {
    const first = await cli(["init"], {}, dir);
    assert.equal(first.code, 0);
    const text = readFileSync(path.join(dir, ".env"), "utf8");
    assert.match(text, /^WB_PRIVATE_SECRET=[0-9a-f]{64}$/m);
    const second = await cli(["init"], {}, dir);
    assert.equal(second.code, 1);
    assert.match(second.stdout, /已存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
