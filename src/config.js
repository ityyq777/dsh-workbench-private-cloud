// 运行配置：全部来自环境变量，敏感信息不落代码库。
import { readFileSync } from "node:fs";
import path from "node:path";

const MIN_SECRET_LENGTH = 16;

function readSecret(env) {
  const direct = String(env.WB_PRIVATE_SECRET ?? "").trim();
  if (direct) return direct;
  const file = String(env.WB_PRIVATE_SECRET_FILE ?? "").trim();
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch (e) {
    throw new Error("读取 WB_PRIVATE_SECRET_FILE 失败：" + String(e?.message || e));
  }
}

function intEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(key + " 必须是整数");
  return value;
}

function boolEnv(env, key, fallback = false) {
  const raw = String(env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * 读取并校验配置。校验失败时一次性列出全部问题，启动阶段直接退出，
 * 避免服务在“半配置”状态下把密钥泄漏或把数据写到意外目录。
 */
export function loadConfig(env = process.env) {
  const secret = readSecret(env);
  const config = {
    host: String(env.WB_PRIVATE_BIND ?? "0.0.0.0").trim() || "0.0.0.0",
    port: intEnv(env, "WB_PRIVATE_PORT", 8792),
    secret,
    dataDir: path.resolve(String(env.WB_PRIVATE_DATA ?? "./data")),
    serverName: String(env.WB_PRIVATE_SERVER_NAME ?? "我的私人云端").trim() || "我的私人云端",
    maxFileBytes: intEnv(env, "WB_PRIVATE_MAX_FILE_BYTES", 200 * 1024 * 1024),
    quotaBytes: intEnv(env, "WB_PRIVATE_QUOTA_BYTES", 20 * 1024 * 1024 * 1024),
    sessionTtlMs: intEnv(env, "WB_PRIVATE_SESSION_TTL_SECONDS", 300) * 1000,
    trustProxy: boolEnv(env, "WB_PRIVATE_TRUST_PROXY", false),
  };
  const problems = [];
  if (secret.length < MIN_SECRET_LENGTH) {
    problems.push("必须通过 WB_PRIVATE_SECRET 或 WB_PRIVATE_SECRET_FILE 提供至少 " + MIN_SECRET_LENGTH + " 位的访问密钥");
  }
  if (/[\r\n]/.test(secret)) problems.push("访问密钥里不允许出现换行符");
  if (config.port < 1 || config.port > 65535) problems.push("WB_PRIVATE_PORT 必须在 1~65535 之间");
  if (config.maxFileBytes < 1) problems.push("WB_PRIVATE_MAX_FILE_BYTES 必须大于 0");
  if (config.quotaBytes < config.maxFileBytes) problems.push("WB_PRIVATE_QUOTA_BYTES 不能小于单文件上限");
  if (config.sessionTtlMs < 30_000) problems.push("同步会话 TTL 不能短于 30 秒");
  if (problems.length) {
    const err = new Error("私人云端配置有误：\n- " + problems.join("\n- "));
    err.code = "invalid_config";
    throw err;
  }
  return config;
}
