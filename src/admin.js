// 数据清空：删掉私人云端上的全部业务数据、设备记录与文件，只保留实例身份（meta.instance_id）。
// 服务运行中由 /v1/admin/clear 调用，CLI 在服务停止时直接打开同一个库调用，行为完全一致。
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

/** 界面与接口共用的确认词；CLI 的 --yes 也复用它，避免三处各写一份。 */
export const CLEAR_CONFIRM = "清空云端数据";

/**
 * 清空顺序无所谓（库内没有外键），但先删引用它的表再删被引用表更符合直觉：
 * 变更日志 → 行状态/表版本 → 会话 → 设备 → 文件登记，最后删磁盘上的 blob 文件。
 */
const DATA_TABLES = ["change_log", "row_states", "sync_table_state", "sync_sessions", "devices", "blob_refs", "blobs"];

/**
 * 清空云端数据并回收磁盘空间。
 * @param {import("node:sqlite").DatabaseSync} db 已打开的 private-cloud 库
 * @param {string} dataDir 数据目录（blobs/ 与 tmp/ 在其下）
 * @param {() => number} now 时间源，测试可注入
 */
export function clearAllData(db, dataDir, now = () => Date.now()) {
  const counts = {};
  let rows = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of DATA_TABLES) {
      const result = db.prepare("DELETE FROM " + table).run();
      const n = Number(result.changes ?? 0);
      counts[table] = n;
      rows += n;
    }
    // 实例身份保留：健康检查、概览页的 server_name 与后续设备的登录都依赖它。
    db.prepare("DELETE FROM meta WHERE k <> 'instance_id'").run();
    db.prepare("INSERT INTO meta(k, v) VALUES('last_clear_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(now()));
    try {
      db.exec("DELETE FROM sqlite_sequence");
    } catch {
      /* 没有自增表时 sqlite_sequence 不存在，忽略 */
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

  // blob 按 sha 前缀分目录存放，整目录删除最省事；上传时 files.js 会按需重建目录。
  rmSync(path.join(dataDir, "blobs"), { recursive: true, force: true });
  rmSync(path.join(dataDir, "tmp"), { recursive: true, force: true });
  mkdirSync(path.join(dataDir, "blobs"), { recursive: true });
  mkdirSync(path.join(dataDir, "tmp"), { recursive: true });

  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
  } catch {
    /* 回收失败只影响体积，不影响数据已删 */
  }

  return {
    ok: true,
    tables: DATA_TABLES.length,
    rows,
    blobs: counts.blobs ?? 0,
    devices: counts.devices ?? 0,
    cleared_at: now(),
  };
}
