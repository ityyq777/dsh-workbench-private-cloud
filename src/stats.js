// 概览统计：给浏览器页面和 /v1/stats 接口提供同一份只读快照。
export function buildStats({ db, config, files, startedAt, version }) {
  const one = (sql, ...args) => db.prepare(sql).all(...args);

  const devices = one(
    "SELECT d.id, d.name, d.last_sync_at, (SELECT COUNT(*) FROM change_log c WHERE c.device_id = d.id) AS changes FROM devices d ORDER BY d.last_sync_at DESC NULLS LAST, d.id ASC",
  ).map((row) => ({
    id: row.id,
    name: row.name ?? null,
    last_sync_at: row.last_sync_at === null ? null : Number(row.last_sync_at),
    changes: Number(row.changes ?? 0),
  }));

  const tableRows = one(
    "SELECT table_name, COUNT(*) AS rows, SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) AS deleted, MAX(updated_at) AS updated_at FROM row_states GROUP BY table_name",
  );
  const tableMeta = new Map(
    one("SELECT table_name, version, mode, updated_at FROM sync_table_state").map((r) => [r.table_name, r]),
  );
  const lastSeq = new Map(one("SELECT table_name, MAX(server_seq) AS seq FROM change_log GROUP BY table_name").map((r) => [r.table_name, Number(r.seq)]));
  const tables = tableRows
    .map((row) => {
      const meta = tableMeta.get(row.table_name);
      return {
        table: row.table_name,
        rows: Number(row.rows ?? 0),
        deleted: Number(row.deleted ?? 0),
        updated_at: row.updated_at === null ? null : Number(row.updated_at),
        version: meta ? Number(meta.version) : 0,
        mode: meta ? meta.mode : "row",
        last_seq: lastSeq.get(row.table_name) ?? 0,
      };
    })
    .sort((a, b) => a.table.localeCompare(b.table));

  const changeTotal = db.prepare("SELECT COUNT(*) AS n, MIN(server_seq) AS min_seq, MAX(server_seq) AS max_seq FROM change_log").get();
  const byDevice = one("SELECT device_id, COUNT(*) AS n FROM change_log GROUP BY device_id ORDER BY n DESC").map((r) => ({
    device_id: r.device_id,
    changes: Number(r.n ?? 0),
  }));
  const resets = db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE op = 'reset'").get();
  const session = db.prepare("SELECT session_id, device_id, opened_at, expires_at FROM sync_sessions WHERE id = 1").get();
  const blobs = db.prepare("SELECT COUNT(*) AS n FROM blobs WHERE state = 'ready'").get();
  const refs = db.prepare("SELECT COUNT(*) AS n FROM blob_refs WHERE deleted = 0").get();

  return {
    ok: true,
    server: {
      name: config.serverName,
      version,
      protocol: 2,
      started_at: startedAt,
      uptime_s: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      server_time: Date.now(),
    },
    usage: {
      ...files.quota(),
      max_file_bytes: config.maxFileBytes,
      blob_count: Number(blobs.n ?? 0),
      file_refs: Number(refs.n ?? 0),
    },
    devices,
    tables,
    changes: {
      total: Number(changeTotal.n ?? 0),
      min_seq: changeTotal.min_seq === null ? 0 : Number(changeTotal.min_seq),
      max_seq: changeTotal.max_seq === null ? 0 : Number(changeTotal.max_seq),
      resets: Number(resets.n ?? 0),
      by_device: byDevice,
    },
    session: session
      ? {
          device_id: session.device_id,
          opened_at: Number(session.opened_at),
          expires_at: Number(session.expires_at),
          active: Number(session.expires_at) > Date.now(),
        }
      : null,
  };
}
