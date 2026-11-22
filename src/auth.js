// 访问密钥鉴权：单用户模型下只有一把服务端密钥，按 Bearer 头比对。
// 失败次数按来源 IP 做滑动窗口限流，避免可被暴力枚举。
import { timingSafeEqual } from "node:crypto";

const WINDOW_MS = 60_000;
const MAX_FAILURES = 10;
const BLOCK_MS = 60_000;

function bearerOf(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function createAuth({ secret, now = () => Date.now() }) {
  const expected = Buffer.from(secret, "utf8");
  /** ip -> { count, firstAt, blockedUntil } */
  const failures = new Map();

  function prune(ts) {
    if (failures.size < 512) return;
    for (const [ip, state] of failures) {
      if (state.blockedUntil <= ts && ts - state.firstAt > WINDOW_MS) failures.delete(ip);
    }
  }

  /** 返回 { ok:true } 或 { ok:false, blocked, retryAfterMs }。 */
  function authenticate(header, ip = "unknown") {
    const ts = now();
    prune(ts);
    const state = failures.get(ip);
    if (state && state.blockedUntil > ts) {
      return { ok: false, blocked: true, retryAfterMs: state.blockedUntil - ts };
    }
    if (state && ts - state.firstAt > WINDOW_MS && state.blockedUntil <= ts) failures.delete(ip);
    const presented = bearerOf(header);
    if (presented) {
      const got = Buffer.from(presented, "utf8");
      if (got.length === expected.length && timingSafeEqual(got, expected)) {
        failures.delete(ip);
        return { ok: true };
      }
    }
    const current = failures.get(ip) ?? { count: 0, firstAt: ts, blockedUntil: 0 };
    current.count += 1;
    if (current.count >= MAX_FAILURES) current.blockedUntil = ts + BLOCK_MS;
    failures.set(ip, current);
    return { ok: false, blocked: false, retryAfterMs: 0 };
  }

  return { authenticate };
}
