// 接入信息：把「本机连接 / 局域网连接」两种地址算出来，概览页、日志与 CLI 共用。
// 只挑 IPv4 地址；VPN、容器网桥这类虚拟网卡排在物理网卡后面，避免把 100.x 当成局域网地址误导用户。
import os from "node:os";

// 物理网卡常见命名：macOS/Linux 的 en0、eth0、wlan0、wl*。
const PHYSICAL_RE = /^(en|eth|wlan|wl|wifi)/i;
// 虚拟网卡：VPN（utun/tun/tap/ppp）、容器（docker/veth/br-/cni）、虚拟机（vmnet/bridge/vboxnet）、
// 苹果的 AWDL/低功耗蓝牙链路也归到这里，它们不对应「同一 Wi-Fi 下能互访」的局域网。
const VIRTUAL_RE = /^(utun|ipsec|tun|tap|ppp|docker|veth|br-|cni|vmnet|bridge|vboxnet|awdl|llw|gif|stf|anpi)/i;

function ipv4Of(entry) {
  // Node 18 起 family 是字符串 "IPv4"，老版本是数字 4。
  return entry.family === "IPv4" || entry.family === 4;
}

function rank(item) {
  if (item.virtual) return 2;
  return item.preferred ? 0 : 1;
}

/**
 * 列出可用的局域网 IPv4 地址，按「物理网卡优先、网卡名升序」排好。
 * `interfaces` 可注入（测试用），默认读系统网卡；同一地址只保留一条。
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const seen = new Set();
  const list = [];
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (!entry || !ipv4Of(entry) || entry.internal) continue;
      const address = String(entry.address ?? "").trim();
      // 169.254/16 是自动协商失败的链路本地地址，0.0.0.0 不是可访问地址。
      if (!address || address.startsWith("169.254.") || address.startsWith("0.")) continue;
      if (seen.has(address)) continue;
      seen.add(address);
      list.push({ name, address, virtual: VIRTUAL_RE.test(name), preferred: PHYSICAL_RE.test(name) });
    }
  }
  list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return list.map((item) => ({ interface: item.name, address: item.address, virtual: item.virtual }));
}

/**
 * 计算对外展示的接入地址：本机固定 127.0.0.1，局域网取第一块物理网卡起的所有 IPv4。
 * 设了 `WB_PRIVATE_PUBLIC_HOST`（域名或 IP）时以它为准，适合反向代理或固定域名场景。
 */
export function accessInfo(config, interfaces = os.networkInterfaces()) {
  const port = Number(config?.port) > 0 ? Number(config.port) : 8792;
  const override = String(config?.publicHost ?? "").trim();
  const local = "http://127.0.0.1:" + port;
  if (override) {
    return { port, local, override, lan: [{ interface: "手动指定", address: override, virtual: false, url: "http://" + override + ":" + port }] };
  }
  const lan = lanAddresses(interfaces).map((item) => ({ ...item, url: "http://" + item.address + ":" + port }));
  return { port, local, override: null, lan };
}
