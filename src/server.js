// HTTP 路由：/v1/health 公开，其余全部要求 Bearer 密钥。
import http from "node:http";
import { readFileSync } from "node:fs";
import { createAuth } from "./auth.js";
import { ensureMeta } from "./db.js";
import { createFiles } from "./files.js";
import { createSync } from "./sync.js";
import { ApiError, readJson, sendError, sendJson } from "./http.js";
import { newId } from "./util.js";
import { buildStats } from "./stats.js";
import { dashboardHtml } from "./dashboard.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function remoteIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return String(req.socket?.remoteAddress ?? "unknown");
}

export function createApp({ db, config, log = () => {} }) {
  const auth = createAuth({ secret: config.secret });
  const files = createFiles({ db, config, dataDir: config.dataDir });
  const sync = createSync({ db, config, applyFileRef: files.applyFileRef });
  ensureMeta(db, "instance_id", () => newId());
  const startedAt = Date.now();

  function health() {
    return {
      ok: true,
      service: "dsh-workbench-private-cloud",
      mode: "private",
      version: VERSION,
      protocol: 2,
      server_name: config.serverName,
      auth_required: true,
      time: Date.now(),
    };
  }

  function me() {
    const devices = db
      .prepare("SELECT id, name, last_sync_at FROM devices ORDER BY last_sync_at DESC NULLS LAST, id ASC")
      .all()
      .map((row) => ({ id: row.id, name: row.name ?? null, last_sync_at: row.last_sync_at === null ? null : Number(row.last_sync_at) }));
    return {
      ok: true,
      protocol: 2,
      user: { id: "private-owner", name: config.serverName, email: null },
      devices,
      quota: files.quota(),
      server_time: Date.now(),
    };
  }

  async function route(req, res) {
    const url = new URL(req.url ?? "/", "http://local");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const m = req.method ?? "GET";

    if (p === "/" && m === "GET") {
      // 浏览器直接访问给概览页；脚本/探针仍拿 JSON，保持旧行为。
      if (String(req.headers.accept ?? "").includes("text/html")) {
        const page = dashboardHtml(config);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(page),
          "cache-control": "no-store",
        });
        res.end(page);
        return;
      }
      sendJson(res, 200, {
        ...health(),
        endpoints: ["/v1/health", "/v1/me", "/v1/stats", "/v1/sync/*", "/v1/files/*"],
        dashboard: "用浏览器打开本地址可查看概览页",
      });
      return;
    }
    if (p === "/favicon.ico" && m === "GET") {
      res.writeHead(204).end();
      return;
    }
    if (p === "/v1/health" && m === "GET") {
      sendJson(res, 200, health());
      return;
    }

    const ip = remoteIp(req, config.trustProxy);
    const verdict = auth.authenticate(req.headers.authorization, ip);
    if (!verdict.ok) {
      if (verdict.blocked) {
        res.setHeader("retry-after", String(Math.ceil((verdict.retryAfterMs ?? 0) / 1000)));
        sendJson(res, 429, { ok: false, code: "too_many_attempts", error: "鉴权失败次数过多，请稍后再试" });
      } else {
        sendJson(res, 401, { ok: false, code: "unauthorized", error: "访问密钥不正确" });
      }
      return;
    }

    if (p === "/v1/me" && m === "GET") {
      sendJson(res, 200, me());
      return;
    }
    if (p === "/v1/stats" && m === "GET") {
      sendJson(res, 200, buildStats({ db, config, files, startedAt, version: VERSION }));
      return;
    }
    const revoke = /^\/v1\/devices\/([^/]+)$/.exec(p);
    if (revoke && m === "DELETE") {
      db.prepare("DELETE FROM devices WHERE id=?").run(decodeURIComponent(revoke[1]));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p.startsWith("/v1/sync/") && m === "POST") {
      const action = p.slice("/v1/sync/".length);
      const body = await readJson(req, 16 * 1024 * 1024);
      const handlers = { open: sync.open, push: sync.push, pull: sync.pull, snapshot: sync.snapshot, full: sync.full, close: sync.close };
      const handler = handlers[action];
      if (!handler) throw new ApiError(404, "no_sync_route", "未知的同步接口：" + action);
      sendJson(res, 200, handler(body));
      return;
    }

    if (p === "/v1/files/check" && m === "POST") {
      const body = await readJson(req, 1024 * 1024);
      sendJson(res, 200, files.check(body.hashes));
      return;
    }
    if (p === "/v1/files/quota" && m === "GET") {
      sendJson(res, 200, { ok: true, ...files.quota() });
      return;
    }
    const blob = /^\/v1\/files\/blobs\/([^/]+)$/.exec(p);
    if (blob) {
      const sha = decodeURIComponent(blob[1]);
      if (m === "PUT") {
        const result = await files.upload(req, sha, req.headers["content-type"]);
        sendJson(res, result.deduped ? 200 : 201, { ok: true, sha256: sha, size: result.size, deduped: result.deduped });
        return;
      }
      if (m === "GET") {
        files.sendBlob(req, res, sha);
        return;
      }
      if (m === "HEAD") {
        files.headBlob(res, sha);
        return;
      }
    }

    throw new ApiError(404, "not_found", "没有这个接口：" + m + " " + p);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) {
        res.destroy(e);
        return;
      }
      sendError(res, e, log);
    });
  });
  // 大文件上传需要更长的请求超时；正常 JSON 请求不受影响。
  server.requestTimeout = 10 * 60_000;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 15_000;
  return server;
}
