// SQLite 结构：单用户、多设备的协议 v2 存储。所有写入都在事务里完成。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 设备：同一份密钥下的多台设备，只有游标与最后同步时间，不含任何凭据。
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT,
  last_sync_at INTEGER,
  cursors TEXT NOT NULL DEFAULT '{}'
);

-- 变更日志：协议 v2 的服务端权威序列；同设备同会话的 client_seq 唯一。
CREATE TABLE IF NOT EXISTS change_log (
  server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  client_epoch TEXT NOT NULL,
  client_seq INTEGER NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(device_id, client_epoch, client_seq)
);
CREATE INDEX IF NOT EXISTS idx_change_log_table_seq ON change_log(table_name, server_seq);
CREATE INDEX IF NOT EXISTS idx_change_log_seq ON change_log(server_seq);

-- 行状态：当前权威版本，冲突判断与快照都读它。
CREATE TABLE IF NOT EXISTS row_states (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(table_name, row_id)
);

-- 单用户模型下只允许一个活跃同步会话（同一时刻一个设备在写）。
CREATE TABLE IF NOT EXISTS sync_sessions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 表版本与同步模式（row/tree）；第一次出现时按 row 兜底。
CREATE TABLE IF NOT EXISTS sync_table_state (
  table_name TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'row',
  updated_at INTEGER NOT NULL
);

-- 文件：按 sha256 去重，单个本地 blob 目录。
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT,
  state TEXT NOT NULL DEFAULT 'ready',
  created_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL
);

-- 文件行引用：只有被存活文件引用的 blob 才允许下载，避免把存储当公共图床。
CREATE TABLE IF NOT EXISTS blob_refs (
  file_id TEXT PRIMARY KEY,
  sha256 TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blob_refs_sha ON blob_refs(sha256);
`;

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "private-cloud.db"));
  db.exec(SCHEMA_SQL);
  return db;
}

/** meta 里的实例标识：用户 ID、实例 ID 都由它派生，重建数据目录会得到新身份。 */
export function ensureMeta(db, key, factory) {
  const row = db.prepare("SELECT v FROM meta WHERE k=?").get(key);
  if (row) return String(row.v);
  const value = factory();
  db.prepare("INSERT INTO meta(k,v) VALUES(?,?)").run(key, value);
  return value;
}
