#!/usr/bin/env node
// 私人云端命令行：start / stop / restart / status / logs / init / open。
// 用 PID 文件与后台子进程管理服务，零依赖；服务本身仍是 src/index.js。
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../src/env-file.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { CLEAR_CONFIRM, clearAllData } from "../src/admin.js";
import { accessInfo } from "../src/access.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "src", "index.js");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const USAGE = `dsh-workbench-private-cloud ${VERSION}

用法：wb-private-cloud <命令> [选项]

命令：
  start [--foreground]  后台启动（--foreground 即前台运行，等同 npm start）
  stop                  停止后台服务
  restart               重启
  status                查看运行状态与健康检查
  logs [--lines N] [-f] 查看日志（默认最近 50 行，-f 持续跟踪）
  init                  生成 .env（含随机密钥），不覆盖已有文件
  open                  在浏览器打开概览页
  clear [--yes]         清空云端数据（服务运行中走接口，未运行直接清库；--yes 跳过确认）
  version               版本号
  help                  本帮助

通用选项：--port <端口> --data <目录> --bind <地址> --name <名称> --public-host <主机>
  也可以直接用环境变量 WB_PRIVATE_PORT / WB_PRIVATE_DATA / WB_PRIVATE_BIND / WB_PRIVATE_SERVER_NAME /
  WB_PRIVATE_PUBLIC_HOST，或写在当前目录的 .env 里。--public-host 用来覆盖概览页上展示的局域网地址
  （默认自动探测网卡，反代或固定域名时手填）。`;

function parseArgs(argv) {
  const opts = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-f" || a === "--foreground") opts.flags.add("foreground");
    else if (a === "-y" || a === "--yes") opts.flags.add("yes");
    else if (a === "-h" || a === "--help") opts.flags.add("help");
    else if (a === "--lines") opts.values.lines = argv[++i];
    else if (a === "--port") opts.values.port = argv[++i];
    else if (a === "--data") opts.values.data = argv[++i];
    else if (a === "--bind") opts.values.bind = argv[++i];
    else if (a === "--name") opts.values.name = argv[++i];
    else if (a === "--public-host") opts.values.publicHost = argv[++i];
    else if (a.startsWith("-")) throw new Error("未知选项：" + a);
    else if (!opts.command) opts.command = a;
    else throw new Error("多余的参数：" + a);
  }
  return opts;
}

function applyOverrides(opts) {
  if (opts.values.port) process.env.WB_PRIVATE_PORT = String(opts.values.port);
  if (opts.values.data) process.env.WB_PRIVATE_DATA = String(opts.values.data);
  if (opts.values.bind) process.env.WB_PRIVATE_BIND = String(opts.values.bind);
  if (opts.values.name) process.env.WB_PRIVATE_SERVER_NAME = String(opts.values.name);
  if (opts.values.publicHost) process.env.WB_PRIVATE_PUBLIC_HOST = String(opts.values.publicHost);
}

/** 先补齐 .env（当前目录优先，再补仓库根），并让数据目录默认落在包内，避免随 cwd 漂移。 */
function prepareEnv() {
  loadEnvFile(process.cwd());
  loadEnvFile(ROOT);
  if (!process.env.WB_PRIVATE_DATA) process.env.WB_PRIVATE_DATA = path.join(ROOT, "data");
}

/** 读取配置；失败时抛错（由调用方决定是提示还是忽略）。 */
function readConfig() {
  prepareEnv();
  return loadConfig(process.env);
}

/** stop/status 只关心数据目录，配置不全（例如没写密钥）也应能定位 PID 文件。 */
function dataDirOnly() {
  prepareEnv();
  return path.resolve(String(process.env.WB_PRIVATE_DATA));
}

function pidPath(dataDir) {
  return path.join(dataDir, "private-cloud.pid");
}
function logPath(dataDir) {
  return path.join(dataDir, "private-cloud.log");
}

function readPid(dataDir) {
  const file = pidPath(dataDir);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 校验 PID 指向的确实是本服务，避免复用了序号的其他进程被误杀。 */
function looksLikeService(pid) {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return out.includes("src/index.js") || out.includes("wb-private-cloud");
  } catch {
    return false;
  }
}

function runningPid(dataDir) {
  const pid = readPid(dataDir);
  if (pid && alive(pid) && looksLikeService(pid)) return pid;
  if (pid) rmSync(pidPath(dataDir), { force: true });
  return null;
}

async function health(base, timeoutMs = 2000) {
  try {
    const res = await fetch(base + "/v1/health", { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, error: String((e && e.cause && e.cause.code) || (e && e.message) || e) };
  }
}

function baseUrl(config) {
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  return "http://" + host + ":" + config.port;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tailLines(file, n) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return text.split(/\r?\n/).filter(Boolean).slice(-n);
}

async function waitHealthy(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await health(baseUrl(config), 800);
    if (h.ok) return h;
    await sleep(150);
  }
  return null;
}

/** 打印本机与局域网两种连接地址；概览页上也有同样的「连接方式」卡片。 */
function printAccess(config) {
  const access = accessInfo(config);
  console.log("  本机连接：" + access.local + "/");
  if (access.lan.length) {
    for (const item of access.lan) {
      console.log("  局域网连接：" + item.url + "/（" + item.interface + (item.virtual ? "，虚拟网卡" : "") + "）");
    }
  } else {
    console.log("  局域网连接：未探测到可用网卡，可用 WB_PRIVATE_PUBLIC_HOST 手动指定");
  }
}

async function cmdStart(opts) {
  const config = readConfig();
  const running = runningPid(config.dataDir);
  if (running) {
    console.log("服务已在运行（PID " + running + "）：" + baseUrl(config));
    return 1;
  }
  if (opts.flags.has("foreground")) {
    console.log("前台运行，按 Ctrl+C 停止：" + baseUrl(config));
    const child = spawn(process.execPath, [ENTRY], { stdio: "inherit", cwd: ROOT, env: process.env });
    return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
  }
  mkdirSync(config.dataDir, { recursive: true });
  const log = logPath(config.dataDir);
  const fd = openSync(log, "a");
  const child = spawn(process.execPath, [ENTRY], {
    detached: true,
    stdio: ["ignore", fd, fd],
    cwd: ROOT,
    env: process.env,
  });
  child.unref();
  closeSync(fd);
  writeFileSync(pidPath(config.dataDir), String(child.pid) + "\n");
  const h = await waitHealthy(config, 8000);
  // 端口被别的实例占用时，健康检查照样通过；等一拍再确认子进程是否真的活着。
  if (h) await sleep(400);
  if (!h || !alive(child.pid)) {
    console.error("启动失败或超时，最近日志：");
    for (const line of tailLines(log, 20)) console.error("  " + line);
    rmSync(pidPath(config.dataDir), { force: true });
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
    return 1;
  }
  if (!alive(child.pid)) {
    console.error("端口 " + config.port + " 上已有别的服务在响应，本次启动的进程未存活，请先停止占用者。");
    rmSync(pidPath(config.dataDir), { force: true });
    return 1;
  }
  console.log("已启动（PID " + child.pid + "）：" + baseUrl(config));
  printAccess(config);
  console.log("  数据：" + config.dataDir);
  console.log("  日志：" + log);
  return 0;
}

async function cmdStop() {
  const dir = dataDirOnly();
  const pid = runningPid(dir);
  if (!pid) {
    console.log("服务没有在运行");
    return 0;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      rmSync(pidPath(dir), { force: true });
      console.log("已停止（PID " + pid + "）");
      return 0;
    }
    await sleep(120);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
  rmSync(pidPath(dir), { force: true });
  console.log("进程未在 10 秒内退出，已强制结束（PID " + pid + "）");
  return 0;
}

async function cmdRestart(opts) {
  await cmdStop();
  await sleep(300);
  return cmdStart(opts);
}

async function cmdStatus() {
  const dir = dataDirOnly();
  const pid = runningPid(dir);
  let config = null;
  try {
    config = readConfig();
  } catch {
    /* 配置不全时只报进程状态 */
  }
  const base = config ? baseUrl(config) : null;
  const h = base ? await health(base) : { ok: false };
  const label = pid && h.ok ? "运行中" : pid ? "进程在、健康检查失败" : h.ok ? "运行中（未由 CLI 管理，缺少 PID 文件）" : "未运行";
  console.log("状态：" + label);
  if (pid) console.log("  PID：" + pid);
  if (base && !h.ok) console.log("  地址：" + base);
  if (h.ok) {
    console.log("  服务：" + (h.server_name ?? "-") + " v" + (h.version ?? "-") + "（协议 " + (h.protocol ?? "-") + "）");
    printAccess(config);
  } else if (h.error) {
    console.log("  健康检查：" + h.error);
  }
  if (config) console.log("  数据：" + config.dataDir);
  return h.ok ? 0 : pid ? 1 : 3;
}

function cmdLogs(opts) {
  const dir = dataDirOnly();
  const file = logPath(dir);
  if (!existsSync(file)) {
    console.log("还没有日志文件：" + file);
    return 0;
  }
  if (opts.flags.has("follow")) {
    const child = spawn("tail", ["-f", file], { stdio: "inherit" });
    return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
  }
  const n = Math.max(1, Number(opts.values.lines ?? 50) || 50);
  for (const line of tailLines(file, n)) console.log(line);
  return 0;
}

function cmdInit() {
  const file = path.join(process.cwd(), ".env");
  if (existsSync(file)) {
    console.log(".env 已存在，未覆盖：" + file);
    return 1;
  }
  const secret = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"], {
    encoding: "utf8",
  });
  writeFileSync(file, "WB_PRIVATE_SECRET=" + secret + "\n");
  console.log("已生成 .env（密钥 64 位）：" + file);
  console.log("下一步：wb-private-cloud start");
  return 0;
}

async function cmdOpen() {
  const config = readConfig();
  const access = accessInfo(config);
  const target = baseUrl(config) + "/";
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [target], { stdio: "ignore", detached: true }).unref();
  console.log("已在浏览器打开：" + target);
  // 顺手把局域网地址打出来，方便直接抄到手机上。
  if (access.lan.length) {
    for (const item of access.lan) console.log("  手机可用（同一 Wi-Fi）：" + item.url + "/（" + item.interface + "）");
  }
  return 0;
}

/** 交互式确认：必须原样输入确认词；非交互环境要求显式 --yes。 */
async function confirmClear(reason) {
  if (!process.stdin.isTTY) {
    console.error(reason + "\n非交互环境请显式加 --yes 确认。");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(reason + "\n此操作不可撤销。输入「" + CLEAR_CONFIRM + "」继续：");
    return answer.trim() === CLEAR_CONFIRM;
  } finally {
    rl.close();
  }
}

async function cmdClear(opts) {
  const config = readConfig();
  const dir = config.dataDir;
  const base = baseUrl(config);
  const pid = runningPid(dir);
  const h = pid ? await health(base) : { ok: false };

  if (pid && !h.ok) {
    console.error("服务进程在运行（PID " + pid + "）但健康检查失败，请先 restart 或 stop 后再清空。");
    return 1;
  }

  if (pid && h.ok) {
    // 服务在运行时不能直接写库：两个进程同时写会撞锁，也让运行中的会话状态失效。
    if (!opts.flags.has("yes") && !(await confirmClear("将清空私人云端（" + base + "）上的全部数据。"))) {
      console.log("已取消");
      return 1;
    }
    const res = await fetch(base + "/v1/admin/clear", {
      method: "POST",
      headers: { authorization: "Bearer " + config.secret, "content-type": "application/json" },
      body: JSON.stringify({ confirm: CLEAR_CONFIRM }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      console.error("清空失败：" + ((data && data.error) || "HTTP " + res.status));
      return 1;
    }
    console.log("已清空云端数据：" + data.rows + " 行、" + data.blobs + " 个文件");
    console.log("  数据目录：" + dir);
    return 0;
  }

  if (!opts.flags.has("yes") && !(await confirmClear("服务未运行，将直接清空数据目录 " + dir + " 中的数据库。"))) {
    console.log("已取消");
    return 1;
  }
  const db = openDb(dir);
  try {
    const r = clearAllData(db, dir);
    console.log("已清空云端数据：" + r.rows + " 行、" + r.blobs + " 个文件");
    console.log("  数据目录：" + dir);
    return 0;
  } finally {
    db.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.flags.has("help") || opts.command === "help" || !opts.command) {
    console.log(USAGE);
    return opts.command || opts.flags.has("help") ? 0 : 1;
  }
  applyOverrides(opts);
  try {
    switch (opts.command) {
      case "start":
        return await cmdStart(opts);
      case "stop":
        return await cmdStop();
      case "restart":
        return await cmdRestart(opts);
      case "status":
        return await cmdStatus();
      case "logs":
        return await cmdLogs(opts);
      case "init":
        return cmdInit();
      case "open":
        return await cmdOpen();
      case "clear":
        return await cmdClear(opts);
      case "version":
        console.log(VERSION);
        return 0;
      default:
        console.error("未知命令：" + opts.command + "\n");
        console.log(USAGE);
        return 1;
    }
  } catch (e) {
    console.error(String((e && e.message) || e));
    return 1;
  }
}

main().then((code) => process.exit(code));
