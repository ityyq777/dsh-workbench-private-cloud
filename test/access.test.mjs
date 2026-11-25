// 接入信息：局域网地址探测、手动覆盖与概览页的「连接方式」卡片。
import assert from "node:assert/strict";
import { test } from "node:test";
import { accessInfo, lanAddresses } from "../src/access.js";
import { loadConfig } from "../src/config.js";
import { SECRET, call, startServer } from "./helper.mjs";

// 造一组典型网卡：回环、物理 Wi-Fi、第二块物理网卡、VPN、IPv6 与链路本地地址。
const FAKE_INTERFACES = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [{ address: "192.168.0.102", family: "IPv4", internal: false }],
  en5: [{ address: "10.0.0.9", family: "IPv4", internal: false }],
  utun3: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
  awdl0: [{ address: "fe80::1", family: "IPv6", internal: false }],
  bridge0: [{ address: "169.254.12.34", family: "IPv4", internal: false }],
};

test("lanAddresses 过滤回环/链路本地地址，物理网卡排在虚拟网卡前", () => {
  const list = lanAddresses(FAKE_INTERFACES);
  assert.deepEqual(
    list.map((item) => item.address),
    ["192.168.0.102", "10.0.0.9", "100.101.102.103"],
  );
  assert.equal(list[0].interface, "en0");
  // VPN 网卡放最后，避免把 100.x 当成局域网地址；虚拟标记也一并带出。
  assert.equal(list[2].virtual, true);
});

test("lanAddresses 兼容 family 为数字 4、去重并跳过空地址", () => {
  const list = lanAddresses({
    eth0: [
      { address: "172.16.5.5", family: 4, internal: false },
      { address: "", family: 4, internal: false },
    ],
    eth1: [{ address: "172.16.5.5", family: "IPv4", internal: false }],
  });
  assert.deepEqual(list, [{ interface: "eth0", address: "172.16.5.5", virtual: false }]);
});

test("accessInfo 默认用网卡探测，端口来自配置", () => {
  const info = accessInfo({ port: 9000 }, FAKE_INTERFACES);
  assert.equal(info.local, "http://127.0.0.1:9000");
  assert.equal(info.override, null);
  assert.deepEqual(
    info.lan.map((item) => item.url),
    ["http://192.168.0.102:9000", "http://10.0.0.9:9000", "http://100.101.102.103:9000"],
  );
});

test("accessInfo 在配置 WB_PRIVATE_PUBLIC_HOST 时以手动地址为准", () => {
  const info = accessInfo({ port: 8792, publicHost: "cloud.example.lan" }, FAKE_INTERFACES);
  assert.equal(info.override, "cloud.example.lan");
  assert.deepEqual(info.lan, [
    { interface: "手动指定", address: "cloud.example.lan", virtual: false, url: "http://cloud.example.lan:8792" },
  ]);
});

test("WB_PRIVATE_PUBLIC_HOST 只接受主机名或 IP", () => {
  const base = { WB_PRIVATE_SECRET: SECRET, WB_PRIVATE_DATA: "/tmp/wb-access-test" };
  assert.throws(() => loadConfig({ ...base, WB_PRIVATE_PUBLIC_HOST: "http://192.168.1.50" }), /只填主机名或 IP/);
  assert.throws(() => loadConfig({ ...base, WB_PRIVATE_PUBLIC_HOST: "192.168.1.50/lan" }), /只填主机名或 IP/);
  assert.equal(loadConfig({ ...base, WB_PRIVATE_PUBLIC_HOST: "cloud.example.lan" }).publicHost, "cloud.example.lan");
});

test("概览页展示本机与局域网连接方式，且不暴露密钥", async () => {
  const app = await startServer({ WB_PRIVATE_PUBLIC_HOST: "192.168.1.50" });
  try {
    const page = await call(app.base, "GET", "/", { headers: { accept: "text/html" } });
    assert.equal(page.status, 200);
    const html = page.buffer.toString("utf8");
    assert.match(html, /连接方式/);
    assert.match(html, /本机连接/);
    assert.match(html, /局域网连接/);
    const local = "http://127.0.0.1:" + app.config.port;
    assert.ok(html.includes(local), "页面应包含本机地址：" + local);
    assert.ok(html.includes("http://192.168.1.50:" + app.config.port), "页面应包含局域网地址");
    assert.ok(html.includes('data-copy="' + local + '"'), "地址旁应有复制按钮");
    assert.equal(html.includes(SECRET), false);
  } finally {
    await app.close();
  }
});
