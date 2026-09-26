/**
 * 自检脚本：用真实 MCP 客户端连上 adb-mcp server，
 * 列举工具并逐个试跑关键能力（含 scrcpy 投屏生命周期）。
 *
 *   npm run selftest
 *   ADB_EXE=... SCRCPY_EXE=... node selftest.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.js");

const client = new Client({ name: "adb-mcp-selftest", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env, ADB_MCP_DEBUG: "0" },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function show(title, res) {
  const parts = [];
  for (const c of res?.content ?? []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "image") parts.push(`<image ${c.mimeType} base64 ${c.data.length} chars>`);
    else parts.push(JSON.stringify(c));
  }
  const body = parts.join("\n");
  const preview = body.length > 800 ? body.slice(0, 800) + "\n…[预览截断]" : body;
  console.log(`\n──── ${title} ${res?.isError ? "[ERROR]" : ""} ────\n${preview}`);
}

async function call(name, args = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    show(name, r);
    return r;
  } catch (e) {
    console.log(`\n──── ${name} ────\n调用异常: ${e.message}`);
    return null;
  }
}

await client.connect(transport);
console.log("MCP 连接建立");

const tools = await client.listTools();
console.log(`\n共注册 ${tools.tools.length} 个工具：`);
console.log(tools.tools.map((t) => "  • " + t.name).join("\n"));

// 1. 环境
await call("env_check");
await call("list_devices");

// 2. 设备信息
await call("device_info");

// 3. 只读 shell
await call("shell", { command: "getprop ro.product.model; getprop ro.build.version.release" });

// 4. 安全拦截：应被拒绝
await call("shell", { command: "rm -rf /system" });

// 5. UI 层级 + 截图
await call("ui_dump", { only_clickable: true });
await call("screenshot", { max_width: 720 });

// 6. 前台应用 + 日志
await call("current_app");
await call("logcat", { lines: 20, filter: "ActivityManager|Error" });

// 7. scrcpy 投屏生命周期
await call("scrcpy_start", { max_size: 1024, bit_rate: "4M", window_title: "adb-mcp selftest" });
await sleep(3000);
await call("scrcpy_status");
await call("scrcpy_stop", { all: true });

console.log("\n自检结束");
await client.close();
process.exit(0);
