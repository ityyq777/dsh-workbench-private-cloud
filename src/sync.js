// 同步协议 v2：与共享云端 dsh-workbench-cloud 的 SyncService 行为逐条对齐。
// 单用户模型：所有表不再带 user_id，只有一份“主人”数据。
import { ApiError, badRequest } from "./http.js";
import { canonical, canonicalSize, newId } from "./util.js";

const TABLE_RE = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_PUSH_ITEMS = 500;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PULL_LIMIT = 1000;
const MAX_SNAPSHOT_ROWS = 20000;
const MAX_FULL_ROWS = 50000;
const MAX_FULL_BYTES = 16 * 1024 * 1024;

function assertTable(table) {
  if (typeof table !== "string" || !TABLE_RE.test(table)) {
    throw badRequest("invalid_table", "table_name 不合法");
  }
  return table;
}

function textOf(body, field) {
  const value = body?.[field];
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function intOf(body, field) {
  const value = body?.[field];
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value;
}

export function createSync({ db, config, now = () => Date.now(), applyFileRef = () => {} }) {
  const ttlMs = Math.max(10_000, Math.min(config.sessionTtlMs, 600_000));

  function tableState(table) {
    const row = db.prepare("SELECT version, mode FROM sync_table_state WHERE table_name=?").get(table);
    return row ? { version: Number(row.version), mode: row.mode === "tree" ? "tree" : "row" } : { version: 0, mode: "row" };
  }

  function session() {
    return db.prepare("SELECT session_id, device_id, expires_at FROM sync_sessions WHERE id=1").get();
  }

  /** 校验会话有效期；不合法统一 401 session_*，让宿主重新 open。 */
  function touch(sessionId) {
    const cur = session();
    if (!cur || cur.session_id !== sessionId) throw new ApiError(401, "session_not_found", "同步会话不存在或已过期");
    if (Number(cur.expires_at) <= now()) {
      db.prepare("DELETE FROM sync_sessions WHERE id=1").run();
      throw new ApiError(401, "session_expired", "同步会话已过期");
    }
    return cur;
  }

  /**
   * 会话即设备身份：device_id 由 open 写进会话，后续请求只认 session_id。
   * 宿主协议不带 device_id，若客户端显式传了就必须与会话一致。
   */
  function requireSessionBody(body) {
    const sessionId = textOf(body, "session_id");
    if (!sessionId) throw badRequest("invalid_session", "session_id 必填");
    const cur = touch(sessionId);
    const claimed = textOf(body, "device_id");
    if (claimed && claimed !== cur.device_id) {
      throw new ApiError(401, "session_device_mismatch", "同步会话不属于当前设备");
    }
    return { sessionId, deviceId: cur.device_id };
  }

  /** 打开同步会话；同设备允许重开，换设备则返回 409 sync_locked。 */
  function open(body) {
    if (Number(body.protocol) !== 2) throw new ApiError(426, "protocol_required", "需要协议 v2");
    const deviceId = textOf(body, "device_id");
    if (!deviceId || deviceId.length > 200) throw badRequest("invalid_device", "device_id 必填且不超过 200 字符");
    const deviceName = textOf(body, "device_name");
    const ts = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM sync_sessions WHERE expires_at<=?").run(ts);
      const cur = session();
      if (cur && cur.device_id !== deviceId) {
        throw new ApiError(409, "sync_locked", "另一个设备正在同步", {
          retry_after_ms: Math.max(1, Number(cur.expires_at) - ts),
        });
      }
      db.prepare("DELETE FROM sync_sessions WHERE id=1").run();
      const sessionId = newId();
      const expiresAt = ts + ttlMs;
      db.prepare("INSERT INTO sync_sessions(id, session_id, device_id, opened_at, expires_at) VALUES(1,?,?,?,?)")
        .run(sessionId, deviceId, ts, expiresAt);
      db.prepare(
        "INSERT INTO devices(id,name,last_sync_at,cursors) VALUES(?,?,NULL,'{}') " +
          "ON CONFLICT(id) DO UPDATE SET name=COALESCE(excluded.name, devices.name)",
      ).run(deviceId, deviceName);
      const tables = {};
      for (const row of db.prepare("SELECT table_name, version, mode FROM sync_table_state ORDER BY table_name").all()) {
        tables[String(row.table_name)] = { version: Number(row.version), mode: row.mode === "tree" ? "tree" : "row" };
      }
      db.exec("COMMIT");
      return { ok: true, session_id: sessionId, server_time: ts, expires_at: expiresAt, tables };
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 事务已结束 */
      }
      throw e;
    }
  }

  function push(body) {
    const { sessionId, deviceId } = requireSessionBody(body);
    const epoch = textOf(body, "client_epoch");
    if (!epoch) throw badRequest("epoch_required", "client_epoch 必填");
    const changes = body.changes;
    if (!Array.isArray(changes)) throw badRequest("invalid_changes", "changes 必须是数组");
    if (changes.length > MAX_PUSH_ITEMS) throw new ApiError(413, "too_many_changes", "单批变更过多");
    touch(sessionId);

    const results = [];
    const accepted = [];
    let acceptedUpTo = 0;
    for (const raw of changes) {
      const item = raw && typeof raw === "object" ? raw : {};
      const clientSeq = intOf(item, "client_seq");
      const table = typeof item.table_name === "string" ? item.table_name : null;
      const rowId = typeof item.row_id === "string" ? item.row_id : null;
      const op = typeof item.op === "string" ? item.op : null;
      const updatedAt = intOf(item, "updated_at");
      const payload = item.payload;
      const reject = (message) => results.push({ client_seq: clientSeq ?? 0, table_name: table, row_id: rowId, status: "invalid", error: message, current: null });

      if (clientSeq === null || clientSeq < 1) {
        reject("client_seq 不合法");
        continue;
      }
      acceptedUpTo = Math.max(acceptedUpTo, clientSeq);
      if (!table || !TABLE_RE.test(table)) {
        reject("table_name 不合法");
        continue;
      }
      if (!rowId || !rowId.trim() || rowId.length > 200) {
        reject("row_id 不合法");
        continue;
      }
      if (op !== "upsert" && op !== "delete") {
        reject("op 只能是 upsert 或 delete");
        continue;
      }
      if (updatedAt === null) {
        reject("updated_at 不合法");
        continue;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        reject("payload 必须是对象");
        continue;
      }
      if (String(payload.id) !== rowId) {
        reject("payload.id 必须等于 row_id");
        continue;
      }
      const payloadUpdatedAt = intOf(payload, "updated_at");
      if (payloadUpdatedAt === null || payloadUpdatedAt !== updatedAt) {
        reject("payload.updated_at 必须等于 updated_at");
        continue;
      }
      let canonicalPayload;
      try {
        canonicalPayload = canonical(payload);
      } catch (e) {
        reject(String(e?.message || e));
        continue;
      }
      if (Buffer.byteLength(canonicalPayload, "utf8") > MAX_PAYLOAD_BYTES) {
        reject("payload 过大");
        continue;
      }

      const dup = db
        .prepare("SELECT 1 FROM change_log WHERE device_id=? AND client_epoch=? AND client_seq=?")
        .get(deviceId, epoch, clientSeq);
      const currentRow = db
        .prepare("SELECT payload, updated_at FROM row_states WHERE table_name=? AND row_id=?")
        .get(table, rowId);
      if (dup) {
        results.push({ client_seq: clientSeq, table_name: table, row_id: rowId, status: "duplicate", current: parsePayload(currentRow) });
        continue;
      }
      if (currentRow) {
        const curUpdated = Number(currentRow.updated_at);
        if (curUpdated > updatedAt) {
          results.push({ client_seq: clientSeq, table_name: table, row_id: rowId, status: "conflict", current: parsePayload(currentRow) });
          continue;
        }
        if (curUpdated === updatedAt) {
          const same = canonicalPayload === currentRow.payload;
          results.push({
            client_seq: clientSeq,
            table_name: table,
            row_id: rowId,
            status: same ? "equal" : "conflict",
            current: parsePayload(currentRow),
          });
          continue;
        }
      }
      accepted.push({ clientSeq, table, rowId, op, payload, canonicalPayload, updatedAt });
      results.push({ client_seq: clientSeq, table_name: table, row_id: rowId, status: "accepted", current: null });
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of accepted) {
        const deleted = item.payload.deleted_at !== undefined && item.payload.deleted_at !== null;
        db.prepare(
          "INSERT INTO row_states(table_name,row_id,payload,deleted,updated_at) VALUES(?,?,?,?,?) " +
            "ON CONFLICT(table_name,row_id) DO UPDATE SET payload=excluded.payload, deleted=excluded.deleted, updated_at=excluded.updated_at",
        ).run(item.table, item.rowId, item.canonicalPayload, deleted ? 1 : 0, item.updatedAt);
        db.prepare(
          "INSERT INTO change_log(device_id,client_epoch,client_seq,table_name,row_id,op,payload,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        ).run(deviceId, epoch, item.clientSeq, item.table, item.rowId, item.op, item.canonicalPayload, item.updatedAt);
        applyFileRef(item.table, item.op, item.payload, item.updatedAt);
      }
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    }
    return { ok: true, accepted_up_to: acceptedUpTo, results, server_time: now() };
  }

  function pull(body) {
    const { sessionId, deviceId } = requireSessionBody(body);
    touch(sessionId);
    const cursors = {};
    if (body.cursors && typeof body.cursors === "object" && !Array.isArray(body.cursors)) {
      for (const [table, value] of Object.entries(body.cursors)) {
        if (!TABLE_RE.test(table)) continue;
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) cursors[table] = value;
      }
    }
    const rawLimit = intOf(body, "limit");
    const limit = rawLimit === null ? 200 : Math.max(1, Math.min(MAX_PULL_LIMIT, rawLimit));

    const merged = [];
    const stmt = db.prepare(
      "SELECT server_seq, device_id, client_epoch, table_name, row_id, op, payload, updated_at " +
        "FROM change_log WHERE table_name=? AND server_seq>? ORDER BY server_seq ASC LIMIT ?",
    );
    for (const [table, cursor] of Object.entries(cursors)) {
      for (const row of stmt.all(table, cursor, limit + 1)) {
        merged.push({
          server_seq: Number(row.server_seq),
          device_id: row.device_id,
          client_epoch: row.client_epoch,
          table_name: row.table_name,
          row_id: row.row_id,
          op: row.op,
          payload: row.payload === null ? null : JSON.parse(row.payload),
          updated_at: Number(row.updated_at),
        });
      }
    }
    merged.sort((a, b) => a.server_seq - b.server_seq);
    const entries = merged.slice(0, limit);
    const nextCursors = { ...cursors };
    for (const entry of entries) {
      nextCursors[entry.table_name] = Math.max(nextCursors[entry.table_name] ?? 0, entry.server_seq);
    }
    let hasMore = merged.length > entries.length;
    if (!hasMore) {
      const moreStmt = db.prepare("SELECT 1 FROM change_log WHERE table_name=? AND server_seq>? LIMIT 1");
      for (const table of Object.keys(cursors)) {
        if (moreStmt.get(table, nextCursors[table] ?? 0)) {
          hasMore = true;
          break;
        }
      }
    }
    const min = db.prepare("SELECT MIN(server_seq) AS m FROM change_log").get();
    return {
      ok: true,
      entries,
      next_cursors: nextCursors,
      has_more: hasMore,
      min_seq: min && min.m !== null ? Number(min.m) : 0,
      server_time: now(),
    };
  }

  function snapshot(body) {
    const { sessionId, deviceId } = requireSessionBody(body);
    touch(sessionId);
    const table = assertTable(body.table ?? body.table_name);
    const rows = db
      .prepare("SELECT payload FROM row_states WHERE table_name=? ORDER BY row_id ASC LIMIT ?")
      .all(table, MAX_SNAPSHOT_ROWS + 1);
    if (rows.length > MAX_SNAPSHOT_ROWS) throw new ApiError(413, "snapshot_too_large", "快照过大，请缩小表或分批");
    const state = tableState(table);
    const cursor = db.prepare("SELECT MAX(server_seq) AS m FROM change_log WHERE table_name=?").get(table);
    return {
      ok: true,
      table_name: table,
      rows: rows.map((row) => JSON.parse(row.payload)),
      cursor: cursor && cursor.m !== null ? Number(cursor.m) : 0,
      version: state.version,
      mode: state.mode,
      server_time: now(),
    };
  }

  function full(body) {
    const { sessionId, deviceId } = requireSessionBody(body);
    touch(sessionId);
    const table = assertTable(body.table ?? body.table_name);
    const baseVersion = intOf(body, "base_version");
    if (baseVersion === null || baseVersion < 0) throw badRequest("invalid_base_version", "base_version 必须是非负整数");
    const rawRows = body.rows;
    if (!Array.isArray(rawRows)) throw badRequest("invalid_rows", "rows 必须是数组");
    if (rawRows.length > MAX_FULL_ROWS) throw new ApiError(413, "full_too_large", "整表行数过多");

    const rows = [];
    const seen = new Set();
    let bytes = 0;
    for (const raw of rawRows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("invalid_row", "每一行必须是对象");
      const id = typeof raw.id === "string" ? raw.id : null;
      const updatedAt = intOf(raw, "updated_at");
      if (!id || id.length > 200 || seen.has(id)) throw badRequest("invalid_row", "行 id 非法或重复");
      if (updatedAt === null) throw badRequest("invalid_row", "行 updated_at 非法");
      seen.add(id);
      const payload = canonical(raw);
      bytes += Buffer.byteLength(payload, "utf8");
      if (bytes > MAX_FULL_BYTES) throw new ApiError(413, "full_too_large", "整表体积过大");
      const deleted = raw.deleted_at !== undefined && raw.deleted_at !== null;
      rows.push({ id, payload, deleted, updatedAt });
    }

    const ts = now();
    const state = tableState(table);
    if (state.version !== baseVersion) {
      throw new ApiError(409, "version_conflict", "表版本已变化", { version: state.version });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM row_states WHERE table_name=?").run(table);
      const insert = db.prepare("INSERT INTO row_states(table_name,row_id,payload,deleted,updated_at) VALUES(?,?,?,?,?)");
      for (const row of rows) insert.run(table, row.id, row.payload, row.deleted ? 1 : 0, row.updatedAt);
      const nextVersion = state.version + 1;
      db.prepare(
        "INSERT INTO sync_table_state(table_name,version,mode,updated_at) VALUES(?,?,'tree',?) " +
          "ON CONFLICT(table_name) DO UPDATE SET version=excluded.version, mode=excluded.mode, updated_at=excluded.updated_at",
      ).run(table, nextVersion, ts);
      db.prepare(
        "INSERT INTO change_log(device_id,client_epoch,client_seq,table_name,row_id,op,payload,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(deviceId, "reset-" + newId(), 0, table, "*", "reset", canonical({ version: nextVersion }), ts);
      const cursor = db.prepare("SELECT MAX(server_seq) AS m FROM change_log WHERE table_name=?").get(table);
      db.exec("COMMIT");
      return {
        ok: true,
        table_name: table,
        version: nextVersion,
        cursor: cursor && cursor.m !== null ? Number(cursor.m) : 0,
        server_time: ts,
      };
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  function close(body) {
    const { sessionId, deviceId } = requireSessionBody(body);
    const success = body.success === true;
    db.prepare("DELETE FROM sync_sessions WHERE id=1 AND session_id=?").run(sessionId);
    if (success) {
      const cursors = {};
      if (body.cursors && typeof body.cursors === "object" && !Array.isArray(body.cursors)) {
        for (const [table, value] of Object.entries(body.cursors)) {
          if (TABLE_RE.test(table) && typeof value === "number" && Number.isInteger(value) && value >= 0) cursors[table] = value;
        }
      }
      db.prepare("UPDATE devices SET last_sync_at=?, cursors=? WHERE id=?").run(now(), JSON.stringify(cursors), deviceId);
    }
    return { ok: true };
  }

  return { open, push, pull, snapshot, full, close };
}

function parsePayload(row) {
  return row ? JSON.parse(row.payload) : null;
}
