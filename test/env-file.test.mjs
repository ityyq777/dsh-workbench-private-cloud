// .env 解析：覆盖注释、export 前缀、引号与“已有环境变量优先”的约定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnvFile, loadEnvFile } from "../src/env-file.js";

test("解析基本键值、注释与 export 前缀", () => {
  const got = parseEnvFile(["# 注释", "", "A=1", "export B=2", 'C="带 空格"', "D='单引号'", "坏行", "E="].join("\n"));
  assert.deepEqual(got, { A: "1", B: "2", C: "带 空格", D: "单引号", E: "" });
});

test(".env 只补齐缺失的环境变量", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wb-env-"));
  writeFileSync(path.join(dir, ".env"), "WB_PRIVATE_SECRET=from-file\nWB_PRIVATE_PORT=9999\n");
  const env = { WB_PRIVATE_SECRET: "from-shell" };
  const applied = loadEnvFile(dir, env);
  assert.deepEqual(applied, ["WB_PRIVATE_PORT"]);
  assert.equal(env.WB_PRIVATE_SECRET, "from-shell");
  assert.equal(env.WB_PRIVATE_PORT, "9999");
});

test("没有 .env 时不报错", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wb-env-"));
  assert.deepEqual(loadEnvFile(dir, {}), []);
});
