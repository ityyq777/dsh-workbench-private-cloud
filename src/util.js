// 通用小工具：规范化 JSON、ID 与时间。
import { randomUUID } from "node:crypto";

/** 把任意 JSON 值转成键有序的规范字符串；冲突比较与去重都依赖它。 */
export function canonical(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON 数值必须是有限数");
    return JSON.stringify(value);
  }
  if (type === "boolean" || type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((item) => (item === undefined ? "null" : canonical(item))).join(",") + "]";
  if (type === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    const body = keys.map((key) => JSON.stringify(key) + ":" + canonical(value[key]));
    return "{" + body.join(",") + "}";
  }
  throw new Error("不支持序列化的值类型：" + type);
}

/** 规范 JSON 的字节长度；服务端限制单行与整批体积时使用。 */
export function canonicalSize(value) {
  return Buffer.byteLength(canonical(value), "utf8");
}

/** 服务端会话 ID 等唯一标识。 */
export function newId() {
  return randomUUID();
}

/** 传值非法时抛出、由 HTTP 层转成 4xx 的统一助手。 */
export function requireString(value, field, min = 1, max = 200) {
  if (typeof value !== "string") throw badRequest("invalid_" + field, field + " 必须是字符串");
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw badRequest("invalid_" + field, field + " 长度必须在 " + min + "~" + max + " 之间");
  }
  return text;
}

export function badRequest(error, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = error;
  return err;
}
