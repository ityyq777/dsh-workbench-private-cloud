// HTTP 基础件：统一的错误类型、请求体读取、JSON 响应。
// 所有业务错误都抛 ApiError，路由器只在一处转成响应，避免各处拼 {ok:false}。

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code, message) {
  return new ApiError(400, code, message);
}

export function notFound(code = "not_found", message = "资源不存在") {
  return new ApiError(404, code, message);
}

export async function readBody(req, maxBytes) {
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, "body_too_large", "请求体超过上限");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new ApiError(413, "body_too_large", "请求体超过上限");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, maxBytes = 16 * 1024 * 1024) {
  const body = await readBody(req, maxBytes);
  if (!body.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw badRequest("invalid_json", "请求体不是合法 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("invalid_json", "请求体必须是 JSON 对象");
  }
  return parsed;
}

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

export function sendError(res, err, log) {
  if (err instanceof ApiError) {
    sendJson(res, err.status, { ok: false, error: err.code, message: err.message, ...(err.details ?? {}) });
    return;
  }
  const message = String(err?.message || err);
  log?.("请求处理失败", message);
  sendJson(res, 500, { ok: false, error: "internal_error", message });
}
