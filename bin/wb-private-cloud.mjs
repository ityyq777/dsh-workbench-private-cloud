#!/usr/bin/env node
// 私人云端命令行：start / stop / restart / status / logs / init / open。
// 用 PID 文件与后台子进程管理服务，零依赖；服务本身仍是 src/index.js。
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../src/env-file.js";
import { loadConfig } from "../src/config.js";

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
  version               版本号
  help                  本帮助

通用选项：--port <端口> --data <目录> --bind <地址> --name <名称>
  也可以直接用环境变量 WB_PRIVATE_PORT / WB_PRIVATE_DATA / WB_PRIVATE_BIND / WB_PRIVATE_SERVER_NAME，
  或写在当前目录的 .env 里。`;

function parseArgs(argv) {
  const opts = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-f" || a === "--foreground") opts.flags.add("foreground");
    else if (a === "-h" || a === "--help") opts.flags.add("help");
    else if (a === "--lines") opts.values.lines = argv[++i];
    else if (a === "--port") opts.values.port = argv[++i];
    else if (a === "--data") opts.values.data = argv[++i];
    else if (a === "--bind") opts.values.bind = argv[++i];
    else if (a === "--name") opts.values.name = argv[++i];
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
  console.log("  概览页：" + baseUrl(config) + "/");
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
  if (base) console.log("  地址：" + base);
  if (h.ok) {
    console.log("  服务：" + (h.server_name ?? "-") + " v" + (h.version ?? "-") + "（协议 " + (h.protocol ?? "-") + "）");
    console.log("  概览页：" + base + "/");
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
  const url = baseUrl(config) + "/";
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
  console.log("已在浏览器打开：" + url);
  return 0;
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
