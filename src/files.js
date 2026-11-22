// 文件接口：sha256 去重、本地 blob 目录、配额与 Range 下载。
// 允许下载的前提是“有存活文件引用该 blob”，与共享云端 blob_refs 规则一致。
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { ApiError, badRequest } from "./http.js";

const SHA_RE = /^[0-9a-f]{64}$/;

export function createFiles({ db, config, dataDir, now = () => Date.now() }) {
  const blobRoot = path.join(dataDir, "blobs");
  const tmpRoot = path.join(dataDir, "tmp");
  mkdirSync(blobRoot, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });

  function keyOf(sha) {
    return path.join(blobRoot, sha.slice(0, 2), sha);
  }

  function quota() {
    const row = db.prepare("SELECT COALESCE(SUM(size),0) AS used, COUNT(*) AS count FROM blobs WHERE state='ready'").get();
    return { used_bytes: Number(row.used), quota_bytes: config.quotaBytes, blob_count: Number(row.count) };
  }

  function check(hashes) {
    if (!Array.isArray(hashes) || hashes.length > 200) throw badRequest("invalid_hashes", "hashes 必须是最多 200 个的数组");
    const have = [];
    const missing = [];
    const stmt = db.prepare("SELECT 1 FROM blobs WHERE sha256=? AND state='ready'");
    for (const raw of hashes) {
      const sha = String(raw);
      if (!SHA_RE.test(sha)) throw badRequest("invalid_sha256", "sha256 必须是 64 位小写十六进制");
      (stmt.get(sha) ? have : missing).push(sha);
    }
    return { ok: true, have, missing };
  }

  function requireBlob(sha) {
    if (!SHA_RE.test(sha)) throw badRequest("invalid_sha256", "sha256 必须是 64 位小写十六进制");
    const row = db.prepare("SELECT sha256,size,mime FROM blobs WHERE sha256=? AND state='ready'").get(sha);
    if (!row) throw new ApiError(404, "blob_not_found", "blob 不存在");
    return { sha256: row.sha256, size: Number(row.size), mime: row.mime, file: keyOf(sha) };
  }

  function isReferenced(sha) {
    return Boolean(db.prepare("SELECT 1 FROM blob_refs WHERE sha256=? AND deleted=0 LIMIT 1").get(sha));
  }

  /** 丢弃请求体，让客户端把数据发完再回错误，避免连接被提前关闭。 */
  async function drain(req, limit) {
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) break;
    }
  }

  /** 接收上传：流式落临时文件并同步计算 sha256，避免大文件进内存。 */
  async function upload(req, sha, mime) {
    if (!SHA_RE.test(sha)) {
      await drain(req, config.maxFileBytes);
      throw badRequest("invalid_sha256", "sha256 必须是 64 位小写十六进制");
    }
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (!Number.isFinite(declared) || declared < 0) throw new ApiError(411, "length_required", "必须携带 Content-Length");
    if (declared > config.maxFileBytes) throw new ApiError(413, "file_too_large", "文件超过单文件上限");
    const tmp = path.join(tmpRoot, sha + ".part-" + now() + "-" + Math.random().toString(36).slice(2, 8));
    const digest = createHash("sha256");
    let total = 0;
    const out = createWriteStream(tmp, { flags: "wx" });
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > config.maxFileBytes) throw new ApiError(413, "file_too_large", "文件超过单文件上限");
        digest.update(chunk);
        if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (total !== declared) throw new ApiError(422, "size_mismatch", "内容长度与 Content-Length 不一致");
      const actual = digest.digest("hex");
      if (actual !== sha) throw new ApiError(422, "sha256_mismatch", "内容 sha256 与路径不一致");

      const existing = db.prepare("SELECT size FROM blobs WHERE sha256=? AND state='ready'").get(sha);
      if (existing && Number(existing.size) === total) {
        rmSync(tmp, { force: true });
        return { deduped: true, size: total };
      }
      const used = quota().used_bytes;
      if (used + total > config.quotaBytes) throw new ApiError(413, "quota_exceeded", "存储配额不足");

      const target = keyOf(sha);
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(tmp, target);
      const ts = now();
      db.prepare(
        "INSERT INTO blobs(sha256,size,mime,state,created_at,verified_at,last_access_at) VALUES(?,?,?,'ready',?,?,?) " +
          "ON CONFLICT(sha256) DO UPDATE SET size=excluded.size, mime=excluded.mime, state='ready', verified_at=excluded.verified_at",
      ).run(sha, total, mime || null, ts, ts, ts);
      return { deduped: false, size: total };
    } catch (e) {
      // 不能用 destroy(callback) 等待：流已结束时回调可能永远不触发。
      out.destroy();
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  function parseRange(header, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
    if (!match) return null;
    const [, startRaw, endRaw] = match;
    if (!startRaw && !endRaw) return null;
    let start;
    let end;
    if (!startRaw) {
      const suffix = Number(endRaw);
      if (!Number.isInteger(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(startRaw);
      end = endRaw ? Number(endRaw) : size - 1;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 0 || start >= size || end < start) return null;
    return { start, end: Math.min(end, size - 1) };
  }

  /** 下载：无引用返回 404；支持单段 Range。 */
  function sendBlob(req, res, sha) {
    const blob = requireBlob(sha);
    if (!isReferenced(sha)) throw new ApiError(404, "blob_not_referenced", "blob 没有被任何文件引用");
    if (!existsSync(blob.file)) throw new ApiError(410, "blob_missing", "blob 文件已丢失");
    const size = statSync(blob.file).size;
    const range = req.headers.range ? parseRange(req.headers.range, size) : null;
    if (req.headers.range && !range) {
      res.writeHead(416, { "content-range": "bytes */" + size, "content-length": 0 });
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const headers = {
      "content-type": blob.mime || "application/octet-stream",
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    };
    if (range) headers["content-range"] = "bytes " + start + "-" + end + "/" + size;
    const ts = now();
    db.prepare("UPDATE blobs SET last_access_at=? WHERE sha256=?").run(ts, sha);
    res.writeHead(range ? 206 : 200, headers);
    createReadStream(blob.file, { start, end }).pipe(res);
  }

  function headBlob(res, sha) {
    const blob = requireBlob(sha);
    res.writeHead(200, {
      "content-type": blob.mime || "application/octet-stream",
      "content-length": blob.size,
      "accept-ranges": "bytes",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end();
  }

  /** 从同步接受的 file 行维护 blob_refs；与共享云端 BlobRefIndex 同规则。 */
  function applyFileRef(table, op, payload, updatedAt) {
    if (table !== "file" || !payload || typeof payload !== "object") return;
    const fileId = typeof payload.id === "string" ? payload.id : null;
    if (!fileId) return;
    const sha = typeof payload.sha256 === "string" && SHA_RE.test(payload.sha256) ? payload.sha256 : null;
    const deleted = op === "delete" || (payload.deleted_at !== undefined && payload.deleted_at !== null);
    if (sha) {
      db.prepare(
        "INSERT INTO blob_refs(file_id,sha256,deleted,updated_at) VALUES(?,?,?,?) " +
          "ON CONFLICT(file_id) DO UPDATE SET sha256=excluded.sha256, deleted=excluded.deleted, updated_at=excluded.updated_at",
      ).run(fileId, sha, deleted ? 1 : 0, updatedAt);
      return;
    }
    if (deleted) {
      db.prepare("UPDATE blob_refs SET deleted=1, updated_at=? WHERE file_id=?").run(updatedAt, fileId);
    }
  }

  return { check, quota, upload, sendBlob, headBlob, requireBlob, applyFileRef };
}
