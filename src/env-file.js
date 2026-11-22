// 极简 .env 加载：零依赖，只为省掉 `export` 的坑。
// 规则与常见 dotenv 保持一致的部分：忽略空行与 # 注释、支持可选的 export 前缀、
// 值可以用单/双引号包裹；已存在的环境变量优先，绝不被文件覆盖。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      if ((first === '"' || first === "'") && value[value.length - 1] === first) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/** 读取目录下的 .env（存在才读），只补齐缺失的键。返回实际写入的键名列表。 */
export function loadEnvFile(dir, env = process.env, filename = ".env") {
  const file = path.join(dir, filename);
  if (!existsSync(file)) return [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const applied = [];
  const parsed = parseEnvFile(text);
  for (const key of Object.keys(parsed)) {
    if (env[key] !== undefined && env[key] !== "") continue;
    env[key] = parsed[key];
    applied.push(key);
  }
  return applied;
}
