#!/usr/bin/env node
/**
 * adb-scrcpy MCP Server
 * ------------------------------------------------------------------
 * 给 AI 用的「Android 手机 ⇄ 电脑」连接与控制层，基于 ADB + scrcpy：
 *
 *   - 环境体检（adb / scrcpy / 设备在线状态 / 连接诊断）
 *   - ADB 命令执行（带危险命令分级拦截）
 *   - 设备信息、应用管理、文件互传、日志
 *   - 截图 / 录屏 / UI 层级 dump（让 AI 真正"看懂"屏幕并点击）
 *   - scrcpy 投屏启停（USB / WiFi）
 *   - 无线调试连接与 Android 11+ 配对
 *
 * 传输：stdio（MCP 标准）。stdout 只允许 JSON-RPC，日志一律走 stderr。
 * 配置：全部走环境变量，不含任何私有路径。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 最小 .env 支持：读取项目根目录下的 .env（KEY=VALUE）。
 * 已存在的环境变量优先，.env 只作兜底，方便本地调试与「换台电脑直接跑」。
 */
function loadDotEnv() {
  try {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    const vals = new Map(); // 先收集：同一 key 后出现的覆盖前面的，空值忽略
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      if (val !== "") vals.set(m[1], val);
    }
    for (const [k, v] of vals) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* .env 不可读就跳过 */
  }
}
loadDotEnv();

const IS_WIN = process.platform === "win32";
const LOG = process.env.ADB_MCP_DEBUG === "1";

/** 产物输出目录（截图 / 录屏 / UI dump 临时文件） */
const OUT_DIR = process.env.ADB_MCP_OUT_DIR || path.join(__dirname, "outputs");
const SHOT_DIR = path.join(OUT_DIR, "screenshots");
const REC_DIR = path.join(OUT_DIR, "recordings");

function dbg(...a) {
  if (LOG) process.stderr.write("[adb-mcp] " + a.join(" ") + "\n");
}

/* ==================================================================
 * 可执行文件解析（跨平台，不依赖任何私有路径）
 * ================================================================== */

function sdkRoots() {
  const env = process.env;
  const home = os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    IS_WIN ? path.join(localAppData, "Android", "Sdk") : null,
    !IS_WIN && process.platform === "darwin" ? path.join(home, "Library", "Android", "sdk") : null,
    path.join(home, "Android", "Sdk"),
  ].filter(Boolean);
}

function adbCandidates() {
  const exe = IS_WIN ? "adb.exe" : "adb";
  return [
    process.env.ADB_EXE,
    process.env.ADB_PATH,
    ...sdkRoots().map((r) => path.join(r, "platform-tools", exe)),
    IS_WIN ? "C:\\platform-tools\\adb.exe" : null,
    IS_WIN ? "C:\\adb\\adb.exe" : null,
    "/usr/bin/adb",
    "/usr/local/bin/adb",
    "/opt/homebrew/bin/adb",
  ].filter(Boolean);
}

function scrcpyCandidates() {
  const home = os.homedir();
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  return [
    process.env.SCRCPY_EXE,
    process.env.SCRCPY_PATH,
    IS_WIN ? path.join(pf, "scrcpy", "scrcpy.exe") : null,
    IS_WIN ? path.join(home, "scoop", "apps", "scrcpy", "current", "scrcpy.exe") : null,
    IS_WIN ? "C:\\scrcpy\\scrcpy.exe" : null,
    "/usr/bin/scrcpy",
    "/usr/local/bin/scrcpy",
    "/opt/homebrew/bin/scrcpy",
  ].filter(Boolean);
}

function resolveBin(candidates, fallbackName) {
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return fallbackName; // 交给 PATH
}

const ADB = resolveBin(adbCandidates(), IS_WIN ? "adb.exe" : "adb");
const SCRCPY = resolveBin(scrcpyCandidates(), IS_WIN ? "scrcpy.exe" : "scrcpy");

/* ==================================================================
 * 基础执行器
 * ================================================================== */

function run(cmd, args, opts = {}) {
  const timeout = opts.timeout ?? 30000;
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout, maxBuffer: 1024 * 1024 * 64, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            code: typeof err.code === "number" ? err.code : -1,
            stdout: stdout || "",
            stderr: stderr || err.message || "",
            timedOut: err.killed === true || err.code === "ETIMEDOUT",
          });
        } else {
          resolve({ ok: true, code: 0, stdout: stdout || "", stderr: stderr || "", timedOut: false });
        }
      }
    );
  });
}

/** 执行并返回 Buffer（截图等二进制输出） */
function runBuffer(cmd, args, opts = {}) {
  const timeout = opts.timeout ?? 30000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const errChunks = [];
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`执行超时（${timeout}ms）`));
    }, timeout);
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => errChunks.push(c));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (code !== 0 && buf.length === 0) {
        reject(new Error(Buffer.concat(errChunks).toString("utf8").trim() || `进程退出码 ${code}`));
      } else {
        resolve(buf);
      }
    });
  });
}

function clip(text, n = 12000) {
  if (typeof text !== "string") text = String(text);
  if (text.length <= n) return text;
  return text.slice(0, n) + `\n\n…[输出已截断，共 ${text.length} 字符，仅显示前 ${n}]`;
}

function firstLine(s) {
  return (s || "").split(/\r?\n/).find((l) => l.trim()) || "";
}

async function adb(args, serial, opts = {}) {
  const full = serial ? ["-s", serial, ...args] : args;
  dbg("adb", full.join(" "));
  return run(ADB, full, opts);
}

async function adbShell(cmd, serial, opts = {}) {
  return adb(["shell", cmd], serial, opts);
}

/* ==================================================================
 * 安全策略：危险命令分级
 * ================================================================== */

/** 直接拒绝：会造成不可逆破坏 */
const BLOCK_RULES = [
  [/\brm\s+(-[a-z]*\s+)*\/(system|data|vendor|product|boot|recovery|dev)\b/i, "删除系统分区属于不可逆破坏"],
  [/\b(dd|mkfs|mke2fs|make_f2fs)\b[\s\S]*\b(of=|if=)\s*\/dev\//i, "直接写块设备会清空分区"],
  [/\bfastboot\s+(erase|format|oem\s+unlock|flashing\s+unlock)\b/i, "fastboot 擦除/解锁会清掉数据"],
  [/\bwipe\s+(data|cache|system)\b/i, "recovery wipe 会清空手机"],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/i, "fork 炸弹"],
  [/\brecovery\s+--wipe_data\b/i, "清空整机数据"],
];

/** 需要显式确认：会改变设备状态 */
const CONFIRM_RULES = [
  [/\b(reboot|restart)\b/i, "重启设备"],
  [/\brm\b/i, "删除文件"],
  [/\b(mv|cp|dd|chmod|chown|truncate)\b/i, "修改或覆盖文件"],
  [/\b(pm\s+uninstall|pm\s+clear|pm\s+disable|pm\s+hide|pm\s+install)\b/i, "卸载/禁用/安装应用"],
  [/\b(settings\s+put|svc\s+|setprop\s|setenforce)/i, "修改系统设置或属性"],
  [/\b(am\s+force-stop|kill|killall)\b/i, "杀进程或停服务"],
  [/\b(su\b|magisk)/i, "提权操作"],
  [/\b(content\s+(insert|delete|update))\b/i, "修改系统数据库"],
];

function inspectCommand(cmd) {
  for (const [re, why] of BLOCK_RULES) if (re.test(cmd)) return { level: "block", why };
  for (const [re, why] of CONFIRM_RULES) if (re.test(cmd)) return { level: "confirm", why };
  return { level: "allow" };
}

/* ==================================================================
 * 设备解析
 * ================================================================== */

async function listSerials() {
  const r = await adb(["devices"], null, { timeout: 15000 });
  const lines = (r.stdout || "").split(/\r?\n/).slice(1);
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      return { serial, state, extra: rest.join(" ") };
    });
}

/** 手动指定的默认设备（USB + WiFi 双通道时避免反复询问） */
let defaultSerial = process.env.ADB_SERIAL || null;

async function pickSerial(serial) {
  if (serial) return { serial, err: null };
  if (defaultSerial) return { serial: defaultSerial, err: null };
  const devs = await listSerials();
  const online = devs.filter((d) => d.state === "device");
  if (online.length === 1) return { serial: online[0].serial, err: null };
  if (online.length === 0) {
    return {
      serial: null,
      err: "没有在线设备。请检查 USB 调试是否开启，或用 connect_wifi / adb_pair 连接无线设备，也可先跑 env_check 排查。",
    };
  }
  // 多台设备：判断是否为「同一台手机的 USB + WiFi 双通道」
  const ids = await Promise.all(
    online.map(async (d) => (await adbShell("getprop ro.serialno", d.serial, { timeout: 8000 })).stdout.trim())
  );
  const valid = ids.filter(Boolean);
  if (valid.length === online.length && new Set(valid).size === 1) {
    const usb = online.find((d) => !/:\d{2,5}$/.test(d.serial)) || online[0];
    return { serial: usb.serial, err: null, note: `同一台手机的 USB+WiFi 双通道，自动使用 ${usb.serial}` };
  }
  return {
    serial: null,
    err:
      `检测到 ${online.length} 台不同设备（${online.map((d) => d.serial).join(", ")}），` +
      `必须通过 serial 参数指定，或用 set_default_device 指定默认设备。`,
  };
}

/* ==================================================================
 * scrcpy 进程管理（内存态，随 MCP 服务生命周期）
 * ================================================================== */

const scrcpyProcs = new Map(); // key: serial -> {pid, args, startedAt}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killTree(pid) {
  if (IS_WIN) {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 20000 });
  } else {
    try {
      process.kill(-pid, "SIGTERM"); // detached 进程组
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }
}

/* ==================================================================
 * 输出辅助
 * ================================================================== */

function txt(t) {
  return { content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] };
}
function errText(t) {
  return { isError: true, content: [{ type: "text", text: t }] };
}

/** PNG 缩放（盒式采样），控制回传给模型的图片体积 */
function resizePng(png, targetW) {
  const scale = png.width / targetW;
  const w = targetW;
  const h = Math.max(1, Math.round(png.height / scale));
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * png.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * png.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * png.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * png.width) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let py = y0; py < y1 && py < png.height; py++) {
        for (let px = x0; px < x1 && px < png.width; px++) {
          const i = (png.width * py + px) << 2;
          r += png.data[i];
          g += png.data[i + 1];
          b += png.data[i + 2];
          n++;
        }
      }
      const di = (w * y + x) << 2;
      out.data[di] = Math.round(r / n);
      out.data[di + 1] = Math.round(g / n);
      out.data[di + 2] = Math.round(b / n);
      out.data[di + 3] = 255;
    }
  }
  return { buf: PNG.sync.write(out), w, h };
}

/** uiautomator XML -> 紧凑控件列表 */
function parseUiXml(xml) {
  const nodes = [];
  const nodeRe = /<node\s([^>]*?)\/?>/g;
  let m;
  while ((m = nodeRe.exec(xml))) {
    const attrs = {};
    const attrRe = /([a-zA-Z0-9_.:-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1]))) attrs[a[1]] = a[2];
    const bounds = attrs.bounds || "";
    const bm = bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    const center = bm
      ? { x: Math.round((+bm[1] + +bm[3]) / 2), y: Math.round((+bm[2] + +bm[4]) / 2) }
      : null;
    nodes.push({
      cls: (attrs.class || "").replace("android.widget.", "").replace("android.view.", ""),
      text: attrs.text || "",
      desc: attrs["content-desc"] || "",
      id: attrs["resource-id"] || "",
      clickable: attrs.clickable === "true",
      enabled: attrs.enabled !== "false",
      bounds,
      center,
    });
  }
  return nodes;
}

/* ==================================================================
 * MCP Server
 * ================================================================== */

const server = new McpServer({ name: "adb-scrcpy", version: "1.0.0" });

const serialOpt = z.string().optional().describe("设备序列号；只有一台在线设备时可省略");

/* ---------------- 环境与设备 ---------------- */

server.tool(
  "env_check",
  "环境体检：检查 adb / scrcpy 可执行文件位置与版本、adb server 状态、当前在线设备与连接类型。连接出问题时先跑这个。",
  {},
  async () => {
    const out = [];
    const av = await run(ADB, ["version"], { timeout: 15000 });
    out.push(`【ADB】${ADB}`);
    out.push(av.ok ? `  版本：${firstLine(av.stdout)}` : `  ✗ 无法执行：${av.stderr || "未安装或不在 PATH 中"}`);

    const sv = await run(SCRCPY, ["--version"], { timeout: 15000 });
    out.push(`【scrcpy】${SCRCPY}`);
    out.push(sv.ok ? `  版本：${firstLine(sv.stdout)}` : `  ✗ 无法执行：${(sv.stderr || "").split("\n")[0] || "未安装或不在 PATH 中"}`);

    const devs = await listSerials();
    out.push(`【设备】共 ${devs.length} 条记录`);
    for (const d of devs) {
      const type = /:\d{2,5}$/.test(d.serial) ? "WiFi/tcpip" : "USB";
      let mark = "?";
      if (d.state === "device") mark = "✓ 在线";
      else if (d.state === "unauthorized") mark = "⚠ 未授权（手机上点「允许 USB 调试」）";
      else if (d.state === "offline") mark = "✗ offline（换线/重插/重开 USB 调试）";
      out.push(`  ${mark}  ${d.serial}  [${type}] ${d.extra}`);
    }
    if (!devs.length) {
      out.push("  （没有设备。USB：开发者选项 → USB 调试；WiFi：connect_wifi 或 adb_pair）");
    }

    const online = devs.filter((d) => d.state === "device");
    if (online.length) {
      const r = await adb(["get-state"], online[0].serial, { timeout: 10000 });
      out.push(`【adb server】${r.ok ? `运行中（${r.stdout.trim()}）` : `异常：${(r.stderr || "").split("\n")[0]}`}`);
    } else {
      const r = await run(ADB, ["get-state"], { timeout: 10000 });
      out.push(`【adb server】${r.ok ? "运行中，但没有可用设备" : "异常或无设备（可调用 restart_adb）"}`);
    }

    if (online.length > 1) {
      const ids = await Promise.all(
        online.map(async (d) => (await adbShell("getprop ro.serialno", d.serial, { timeout: 8000 })).stdout.trim())
      );
      if (ids.every(Boolean) && new Set(ids).size === 1) {
        out.push(`【提示】这 ${online.length} 条记录是同一台手机（USB + WiFi 双通道），工具会自动选 USB 通道，无需每次指定 serial。`);
      } else {
        out.push("【提示】检测到多台不同设备，调用工具请带 serial，或用 set_default_device 指定默认设备。");
      }
    }

    out.push(`【产物目录】${OUT_DIR}`);
    return txt(out.join("\n"));
  }
);

server.tool(
  "list_devices",
  "列出所有已连接设备：序列号、状态、型号、连接方式（USB / WiFi）。",
  {},
  async () => {
    const devs = await listSerials();
    if (!devs.length) return txt("没有检测到任何设备。\n提示：USB 需开启「USB 调试」；WiFi 用 connect_wifi(ip)。");
    const lines = [];
    for (const d of devs) {
      const type = /:\d{2,5}$/.test(d.serial) ? "WiFi/tcpip" : "USB";
      let model = "";
      if (d.state === "device") {
        const r = await adbShell("getprop ro.product.model", d.serial, { timeout: 10000 });
        model = (r.stdout || "").trim();
      }
      lines.push(`- ${d.serial}  [${d.state}]  ${type}${model ? "  " + model : ""}`);
    }
    return txt(lines.join("\n"));
  }
);

server.tool(
  "set_default_device",
  "设置默认设备序列号。多设备（尤其 USB+WiFi 双通道）时设置一次，后续所有工具都不用再带 serial。",
  { serial: z.string().describe("设备序列号，例如 VED0218B23012737 或 192.168.1.20:5555") },
  async ({ serial }) => {
    const devs = await listSerials();
    const hit = devs.find((d) => d.serial === serial);
    defaultSerial = serial;
    return txt(
      hit
        ? `默认设备已设为 ${serial}（当前状态 ${hit.state}）。`
        : `已设为 ${serial}，但当前 adb devices 里没看到它，请确认连接。`
    );
  }
);

server.tool(
  "device_info",
  "读取设备详情：厂商、型号、Android 版本、SDK、分辨率、DPI、电量、充电状态、内存、存储、WiFi IP。",
  { serial: serialOpt },
  async ({ serial }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const cmd = [
      'echo "MFR=$(getprop ro.product.manufacturer)"',
      'echo "MDL=$(getprop ro.product.model)"',
      'echo "REL=$(getprop ro.build.version.release)"',
      'echo "SDK=$(getprop ro.build.version.sdk)"',
      'echo "SNO=$(getprop ro.serialno)"',
      'echo "SIZE=$(wm size | grep -m1 size)"',
      'echo "DENS=$(wm density | grep -m1 density)"',
      'echo "BATL=$(dumpsys battery | grep -m1 level:)"',
      'echo "BATS=$(dumpsys battery | grep -m1 status:)"',
      'echo "BATP=$(dumpsys battery | grep -m1 powered:)"',
      'echo "MEMT=$(grep MemTotal /proc/meminfo)"',
      'echo "MEMA=$(grep MemAvailable /proc/meminfo)"',
      'echo "STO=$(df -h /sdcard | tail -1)"',
      'echo "IP=$(ip -o -4 addr show wlan0 | head -1)"',
    ].join(" ; ");
    const r = await adbShell(cmd, p.serial, { timeout: 30000 });
    if (!r.ok && !r.stdout) return errText(`读取失败：${r.stderr || "未知错误"}`);
    const get = (k) => {
      const m = (r.stdout || "").match(new RegExp(`^${k}=(.*)$`, "m"));
      return m ? m[1].trim() : "";
    };
    const num = (s) => (s.match(/(\d+)/) || [])[1] || "";
    const level = num(get("BATL"));
    const charging = /powered:\s*true/i.test(get("BATP")) || num(get("BATS")) === "2";
    const ip = (get("IP").match(/inet\s+(\d+\.\d+\.\d+\.\d+)/) || [])[1] || "";
    const sto = get("STO").split(/\s+/);
    return txt(
      [
        `序列号：${p.serial}`,
        `厂商 / 型号：${get("MFR") || "?"} ${get("MDL") || "?"}`,
        `Android：${get("REL") || "?"}（SDK ${get("SDK") || "?"}）`,
        `机身序列号：${get("SNO") || "?"}`,
        `分辨率 / DPI：${get("SIZE") || "?"}   ${get("DENS") || "?"}`,
        `电量：${level ? level + "%" : "?"}   ${charging ? "充电中" : "未充电"}`,
        `内存：总量 ${get("MEMT").replace(/MemTotal:\s*/, "") || "?"}，可用 ${get("MEMA").replace(/MemAvailable:\s*/, "") || "?"}`,
        `存储 /sdcard：${sto.length > 4 ? `可用 ${sto[3]} / 共 ${sto[1]}` : "?"}`,
        `WiFi IP：${ip || "未连接 WiFi（无线调试需要）"}`,
      ].join("\n")
    );
  }
);

/* ---------------- ADB 命令 ---------------- */

server.tool(
  "shell",
  "在设备上执行一条 shell 命令。只读命令直接执行；涉及删除/重启/卸载/改设置等会先要求确认（第二次调用带 confirm=true）。",
  {
    command: z.string().describe("要执行的 shell 命令，例如：ls /sdcard/Download"),
    serial: serialOpt,
    confirm: z.boolean().optional().describe("危险命令确认为 true 后才会真正执行"),
    timeout_ms: z.number().optional().describe("超时毫秒数，默认 30000"),
  },
  async ({ command, serial, confirm, timeout_ms }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const verdict = inspectCommand(command);
    if (verdict.level === "block") {
      return errText(`已拒绝执行（${verdict.why}）。\n命令：${command}`);
    }
    if (verdict.level === "confirm" && confirm !== true) {
      return errText(
        `该命令会改变设备状态（${verdict.why}），需要确认。\n若要执行，请再次调用 shell 并带 confirm=true。\n命令：${command}`
      );
    }
    const r = await adbShell(command, p.serial, { timeout: timeout_ms ?? 30000 });
    const out = [
      `$ adb shell ${command}`,
      r.timedOut ? "⚠ 执行超时被中断" : "",
      r.stdout ? r.stdout.trimEnd() : "",
      r.stderr?.trim() ? "[stderr]\n" + r.stderr.trim() : "",
      `退出码：${r.code}`,
    ]
      .filter(Boolean)
      .join("\n");
    return txt(clip(out));
  }
);

const HOST_ONLY_ADB_CMDS = ["devices", "version", "start-server", "kill-server", "connect", "disconnect", "pair", "help"];

server.tool(
  "adb_cmd",
  "执行任意 adb 子命令（不含 shell），例如 tcpip 5555、forward、reverse、bugreport 等主机端命令。",
  {
    args: z.array(z.string()).describe('adb 参数数组，例如 ["tcpip","5555"]'),
    serial: serialOpt,
    confirm: z.boolean().optional().describe("危险命令确认为 true 后才会真正执行"),
  },
  async ({ args, serial, confirm }) => {
    if (!Array.isArray(args) || !args.length) return errText("args 不能为空");
    const joined = args.join(" ");
    const verdict = inspectCommand(joined);
    if (verdict.level === "block") return errText(`已拒绝执行（${verdict.why}）。\n命令：adb ${joined}`);
    if (verdict.level === "confirm" && confirm !== true) {
      return errText(`该命令会改变设备状态（${verdict.why}），需要确认。\n请带 confirm=true 重试。\n命令：adb ${joined}`);
    }
    const hostOnly = HOST_ONLY_ADB_CMDS.includes(args[0]);
    let target = null;
    if (!hostOnly) {
      const p = await pickSerial(serial);
      if (p.err) return errText(p.err);
      target = p.serial;
    }
    const r = await adb(args, target, { timeout: 120000 });
    const out = [
      `$ adb ${joined}`,
      r.stdout?.trimEnd(),
      r.stderr?.trim() ? "[stderr]\n" + r.stderr.trim() : "",
      `退出码：${r.code}`,
    ]
      .filter(Boolean)
      .join("\n");
    return txt(clip(out));
  }
);

server.tool(
  "restart_adb",
  "重启本机 adb server（设备掉线、offline、端口异常时的万能第一步）。",
  {},
  async () => {
    const kill = await run(ADB, ["kill-server"], { timeout: 15000 });
    const start = await run(ADB, ["start-server"], { timeout: 25000 });
    const devs = await listSerials();
    return txt(
      [
        "kill-server: " + (kill.ok ? "ok" : kill.stderr || "fail"),
        "start-server: " + (start.ok ? "ok" : start.stderr || "fail"),
        "当前设备：",
        ...devs.map((d) => `  ${d.serial} [${d.state}]`),
      ].join("\n")
    );
  }
);

server.tool(
  "logcat",
  "抓取设备日志。支持关键字过滤与行数限制，输出会在返回前截断以免过大。",
  {
    serial: serialOpt,
    lines: z.number().optional().describe("取最近 N 条，默认 200，最大 20000"),
    filter: z.string().optional().describe("关键字过滤（大小写不敏感，支持 | 分隔多个关键字）"),
    clear: z.boolean().optional().describe("抓之前先清空日志缓冲区"),
  },
  async ({ serial, lines, filter, clear }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    if (clear) await adb(["logcat", "-c"], p.serial, { timeout: 15000 });
    const n = Math.min(Math.max(lines ?? 200, 1), 20000);
    const r = await adb(["logcat", "-v", "time", "-d", "-t", String(n)], p.serial, { timeout: 40000 });
    if (!r.ok) return errText(`logcat 失败：${r.stderr || r.stdout}`);
    let out = r.stdout || "";
    if (filter) {
      const keys = filter.split("|").map((s) => s.trim().toLowerCase()).filter(Boolean);
      out = out.split(/\r?\n/).filter((l) => keys.some((k) => l.toLowerCase().includes(k))).join("\n");
    }
    if (!out.trim()) return txt("（没有匹配的日志）");
    return txt(clip(out.trimEnd(), 14000));
  }
);

/* ---------------- 应用 ---------------- */

server.tool(
  "list_packages",
  "列出设备上的应用包名。",
  {
    serial: serialOpt,
    third_party_only: z.boolean().optional().describe("只看第三方应用（推荐，默认 true）"),
    keyword: z.string().optional().describe("包名关键字过滤，例如 wechat"),
  },
  async ({ serial, third_party_only, keyword }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const args = ["shell", "pm", "list", "packages"];
    if (third_party_only !== false) args.push("-3");
    const r = await adb(args, p.serial, { timeout: 25000 });
    let list = (r.stdout || "").split(/\r?\n/).map((l) => l.replace(/^package:/, "").trim()).filter(Boolean);
    if (keyword) list = list.filter((x) => x.toLowerCase().includes(keyword.toLowerCase()));
    if (!list.length) return txt("（没有匹配的应用）");
    return txt(`共 ${list.length} 个：\n` + clip(list.join("\n"), 10000));
  }
);

server.tool(
  "current_app",
  "查看当前前台显示的是哪个应用 / Activity（判断手机现在停在哪一屏）。",
  { serial: serialOpt },
  async ({ serial }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const r = await adbShell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'", p.serial, { timeout: 20000 });
    if (!r.stdout?.trim()) {
      const r2 = await adbShell("dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'", p.serial, { timeout: 20000 });
      return txt(clip((r2.stdout || "(获取失败)").trim()));
    }
    return txt(clip(r.stdout.trim()));
  }
);

server.tool(
  "start_app",
  "启动应用（按包名自动解析启动 Activity，解析失败时回退 monkey）。",
  { package_name: z.string().describe("应用包名，例如 com.android.settings"), serial: serialOpt },
  async ({ package_name, serial }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const resolve = await adbShell(`cmd package resolve-activity --brief ${package_name}`, p.serial, { timeout: 20000 });
    const m = (resolve.stdout || "").match(/([a-zA-Z0-9_.$]+)\/([a-zA-Z0-9_.$]+)/);
    if (m) {
      const r = await adbShell(`am start -n ${m[1]}/${m[2]}`, p.serial, { timeout: 25000 });
      return txt(clip(`启动 ${m[1]}/${m[2]}\n${r.stdout || r.stderr}`));
    }
    const r = await adbShell(`monkey -p ${package_name} -c android.intent.category.LAUNCHER 1`, p.serial, { timeout: 30000 });
    return txt(clip(`（解析 Activity 失败，已回退 monkey 方式）\n${r.stdout || r.stderr}`));
  }
);

server.tool(
  "stop_app",
  "强制停止应用。",
  { package_name: z.string(), serial: serialOpt },
  async ({ package_name, serial }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    await adbShell(`am force-stop ${package_name}`, p.serial, { timeout: 20000 });
    return txt("已停止 " + package_name);
  }
);

server.tool(
  "install_apk",
  "安装 APK 到设备。",
  {
    apk_path: z.string().describe("电脑上的 APK 文件绝对路径"),
    serial: serialOpt,
    reinstall: z.boolean().optional().describe("覆盖安装并保留数据（-r），默认 true"),
    grant_permissions: z.boolean().optional().describe("自动授予所有运行时权限（-g）"),
  },
  async ({ apk_path, serial, reinstall, grant_permissions }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    if (!fs.existsSync(apk_path)) return errText(`文件不存在：${apk_path}`);
    const args = ["install"];
    if (reinstall !== false) args.push("-r");
    if (grant_permissions) args.push("-g");
    args.push(apk_path);
    const r = await adb(args, p.serial, { timeout: 180000 });
    return txt(clip(r.stdout || r.stderr));
  }
);

server.tool(
  "uninstall_app",
  "卸载应用（需 confirm 确认）。",
  { package_name: z.string(), keep_data: z.boolean().optional().describe("保留数据与缓存（-k）"), serial: serialOpt, confirm: z.boolean().optional() },
  async ({ package_name, keep_data, serial, confirm }) => {
    if (confirm !== true) return errText(`卸载 ${package_name} 会删除应用，请带 confirm=true 确认。`);
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const args = ["uninstall"];
    if (keep_data) args.push("-k");
    args.push(package_name);
    const r = await adb(args, p.serial, { timeout: 120000 });
    return txt(clip(r.stdout || r.stderr));
  }
);

server.tool(
  "open_url",
  "在手机上用浏览器打开一个网址。",
  { url: z.string(), serial: serialOpt },
  async ({ url, serial }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const r = await adbShell(`am start -a android.intent.action.VIEW -d ${JSON.stringify(url)}`, p.serial, { timeout: 25000 });
    return txt(clip(r.stdout || r.stderr));
  }
);

/* ---------------- 输入控制 ---------------- */

server.tool(
  "tap",
  "点击屏幕坐标。标准流程：先 ui_dump 拿到元素中心点，再 tap 该坐标。",
  { x: z.number(), y: z.number(), serial: serialOpt },
  async ({ x, y, serial }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const r = await adbShell(`input tap ${Math.round(x)} ${Math.round(y)}`, p.serial, { timeout: 15000 });
    return txt(r.ok ? `已点击 (${Math.round(x)}, ${Math.round(y)})` : `失败：${r.stderr}`);
  }
);

server.tool(
  "swipe",
  "滑动屏幕（翻页、下拉通知栏、解锁滑动等）。",
  {
    x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
    duration_ms: z.number().optional().describe("滑动时长，默认 300"),
    serial: serialOpt,
  },
  async ({ x1, y1, x2, y2, duration_ms, serial }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const r = await adbShell(
      `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${duration_ms ?? 300}`,
      p.serial,
      { timeout: 20000 }
    );
    return txt(r.ok ? `已滑动 (${x1},${y1}) → (${x2},${y2})` : `失败：${r.stderr}`);
  }
);

server.tool(
  "type_text",
  "输入文本。注意：adb input text 只支持 ASCII，中文请改用 scrcpy 投屏窗口用电脑键盘输入。",
  { text: z.string(), serial: serialOpt },
  async ({ text, serial }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    if (/[^\x00-\x7F]/.test(text)) {
      return errText(
        "adb 的 input text 不支持中文等非 ASCII 字符。\n" +
        "推荐做法：调用 scrcpy_start 开投屏后，在电脑上直接用键盘输入中文。"
      );
    }
    const escaped = text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/ /g, "%s")
      .replace(/[&|;$`<>()]/g, "\\$&");
    const r = await adbShell(`input text "${escaped}"`, p.serial, { timeout: 20000 });
    return txt(r.ok ? "已输入：" + text : `失败：${r.stderr}`);
  }
);

server.tool(
  "keyevent",
  "发送按键事件。常用：4=返回，3=Home，187=最近任务，26=电源，82=菜单，66=回车，67=删除。",
  { keycode: z.string().describe("键码数字或名称，例如 4 / KEYCODE_BACK / HOME"), serial: serialOpt },
  async ({ keycode, serial }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const r = await adbShell(`input keyevent ${keycode}`, p.serial, { timeout: 15000 });
    return txt(r.ok ? `已发送按键 ${keycode}` : `失败：${r.stderr}`);
  }
);

/* ---------------- 屏幕 ---------------- */

server.tool(
  "screenshot",
  "截图并返回图片（AI 可直接看到屏幕内容），同时保存到本地。默认压缩到 720px 宽以节省 token。",
  {
    serial: serialOpt,
    max_width: z.number().optional().describe("返回图片宽度上限，默认 720；传 0 表示原始尺寸"),
    save_only: z.boolean().optional().describe("为 true 时只保存并返回路径，不返回图片内容"),
  },
  async ({ serial, max_width, save_only }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    let raw;
    try {
      raw = await runBuffer(ADB, ["-s", p.serial, "exec-out", "screencap", "-p"], { timeout: 30000 });
    } catch (e) {
      return errText(`截图失败：${e.message}`);
    }
    if (!raw || raw.length < 100) return errText("截图失败：返回数据为空，可能是锁屏、未授权或设备不支持。");

    const safeName = p.serial.replace(/[^\w.-]/g, "_");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fullPath = path.join(SHOT_DIR, `${safeName}_${ts}.png`);
    fs.writeFileSync(fullPath, raw);

    const target = max_width === 0 ? 0 : max_width ?? 720;
    let sendBuf = raw;
    let w = null, h = null, smallPath = null;
    if (target > 0) {
      try {
        const png = PNG.sync.read(raw);
        if (png.width > target) {
          const r2 = resizePng(png, target);
          sendBuf = r2.buf;
          w = r2.w;
          h = r2.h;
          smallPath = path.join(SHOT_DIR, `${safeName}_${ts}_${w}.png`);
          fs.writeFileSync(smallPath, sendBuf);
        }
      } catch {
        /* 解析失败就用原图 */
      }
    }
    if (save_only) {
      return txt(`已保存：${fullPath}${smallPath ? `\n缩略图：${smallPath}（${w}x${h}）` : ""}`);
    }
    return {
      content: [
        { type: "image", data: sendBuf.toString("base64"), mimeType: "image/png" },
        {
          type: "text",
          text:
            `屏幕截图${w ? ` ${w}x${h}（已压缩，原图 ${(raw.length / 1024).toFixed(0)} KB）` : `（原始尺寸，${(raw.length / 1024).toFixed(0)} KB）`}\n` +
            `完整图：${fullPath}${smallPath ? `\n缩略图：${smallPath}` : ""}`,
        },
      ],
    };
  }
);

server.tool(
  "ui_dump",
  "导出当前屏幕的 UI 层级：控件文本、resource-id、是否可点、坐标与中心点。这是 AI 操作手机的「眼睛」——先 dump 再 tap。",
  {
    serial: serialOpt,
    only_clickable: z.boolean().optional().describe("只列可点击元素（默认 false）"),
    keyword: z.string().optional().describe("按文本 / 描述 / resource-id 关键字过滤"),
  },
  async ({ serial, only_clickable, keyword }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const remote = "/sdcard/adb_mcp_uidump.xml";
    const d = await adbShell(`uiautomator dump ${remote}`, p.serial, { timeout: 40000 });
    if (!/dumped to/i.test(d.stdout || "")) {
      return errText(`dump 失败：${(d.stdout || d.stderr || "").trim() || "未知原因（可能锁屏或 uiautomator 无响应）"}`);
    }
    let xml = "";
    try {
      xml = (await runBuffer(ADB, ["-s", p.serial, "exec-out", "cat", remote], { timeout: 30000 })).toString("utf8");
    } catch {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const tmp = path.join(SHOT_DIR, "uidump_tmp.xml");
      await adb(["pull", remote, tmp], p.serial, { timeout: 30000 });
      xml = fs.readFileSync(tmp, "utf8");
    }
    const start = xml.indexOf("<?xml");
    if (start > 0) xml = xml.slice(start);
    let nodes = parseUiXml(xml);
    if (only_clickable) nodes = nodes.filter((n) => n.clickable);
    if (keyword) {
      const k = keyword.toLowerCase();
      nodes = nodes.filter((n) => n.text.toLowerCase().includes(k) || n.desc.toLowerCase().includes(k) || n.id.toLowerCase().includes(k));
    }
    nodes = nodes.filter((n) => n.text || n.desc || n.id || n.clickable);
    if (!nodes.length) return txt("（没有解析到控件。可能屏幕为空或 dump 被限制）");
    const lines = nodes.map((n, i) => {
      const parts = [`[${i}] ${n.cls || "View"}`];
      if (n.text) parts.push(`text="${n.text}"`);
      if (n.desc) parts.push(`desc="${n.desc}"`);
      if (n.id) parts.push(`id=${n.id}`);
      if (n.clickable) parts.push("clickable");
      if (!n.enabled) parts.push("disabled");
      if (n.center) parts.push(`center=(${n.center.x},${n.center.y})`);
      return parts.join("  ");
    });
    return txt(`共 ${nodes.length} 个控件：\n` + clip(lines.join("\n"), 12000));
  }
);

server.tool(
  "record_screen",
  "录屏（阻塞式，最长 180 秒），结束后自动拉回电脑并返回文件路径。",
  {
    duration_sec: z.number().optional().describe("录制秒数，默认 10，最大 180"),
    serial: serialOpt,
    bit_rate_mbps: z.number().optional().describe("码率 Mbps，默认 4"),
  },
  async ({ duration_sec, serial, bit_rate_mbps }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    const dur = Math.min(Math.max(duration_sec ?? 10, 1), 180);
    const remote = `/sdcard/adb_mcp_rec_${Date.now()}.mp4`;
    await adbShell(
      `screenrecord --time-limit ${dur} --bit-rate ${Math.round((bit_rate_mbps ?? 4) * 1000000)} ${remote}`,
      p.serial,
      { timeout: (dur + 40) * 1000 }
    );
    fs.mkdirSync(REC_DIR, { recursive: true });
    const safeName = p.serial.replace(/[^\w.-]/g, "_");
    const local = path.join(REC_DIR, `${safeName}_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.mp4`);
    const pull = await adb(["pull", remote, local], p.serial, { timeout: 120000 });
    await adbShell(`rm -f ${remote}`, p.serial, { timeout: 15000 }).catch(() => {});
    if (!pull.ok || !fs.existsSync(local)) return errText(`录屏或拉取失败：${pull.stderr || pull.stdout}`);
    return txt(`录屏完成（${dur}s）：${local}  ${(fs.statSync(local).size / 1024 / 1024).toFixed(2)} MB`);
  }
);

/* ---------------- 文件 ---------------- */

server.tool(
  "push_file",
  "把电脑上的文件传到手机。",
  { local_path: z.string(), remote_path: z.string().describe("手机目标路径，例如 /sdcard/Download/a.txt"), serial: serialOpt },
  async ({ local_path, remote_path, serial }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    if (!fs.existsSync(local_path)) return errText(`本地文件不存在：${local_path}`);
    const r = await adb(["push", local_path, remote_path], p.serial, { timeout: 180000 });
    return txt(clip(r.stdout || r.stderr));
  }
);

server.tool(
  "pull_file",
  "把手机上的文件拉到电脑。",
  { remote_path: z.string(), local_path: z.string().describe("电脑保存路径"), serial: serialOpt },
  async ({ remote_path, local_path, serial }) => {
    const p = await pickSerial(serial);
    if (p.err) return errText(p.err);
    fs.mkdirSync(path.dirname(local_path), { recursive: true });
    const r = await adb(["pull", remote_path, local_path], p.serial, { timeout: 180000 });
    if (!r.ok) return errText(clip(r.stderr || r.stdout));
    return txt(clip(r.stdout || `已保存到 ${local_path}`));
  }
);

/* ---------------- scrcpy 投屏 ---------------- */

server.tool(
  "scrcpy_start",
  "启动 scrcpy 投屏窗口（后台运行，会弹出窗口）。支持 USB 与 WiFi 设备，可调清晰度、码率、只读模式、关屏、录制等。",
  {
    serial: serialOpt,
    max_size: z.number().optional().describe("画面长边上限，默认 1280"),
    bit_rate: z.string().optional().describe("视频码率，如 8M；默认 8M"),
    max_fps: z.number().optional().describe("帧率上限，默认 60"),
    no_control: z.boolean().optional().describe("只读观看，不能用键鼠操作手机"),
    turn_screen_off: z.boolean().optional().describe("投屏时熄灭手机屏幕"),
    stay_awake: z.boolean().optional().describe("投屏时手机不休眠"),
    fullscreen: z.boolean().optional(),
    always_on_top: z.boolean().optional(),
    show_touches: z.boolean().optional().describe("显示触摸点（演示 / 教学用）"),
    window_title: z.string().optional().describe("窗口标题"),
    record_file: z.string().optional().describe("同时录制成 mp4 的本地路径"),
    extra_args: z.array(z.string()).optional().describe("额外追加给 scrcpy 的命令行参数"),
  },
  async (opts) => {
    const p = await pickSerial(opts.serial);
    if (p.err) return errText(p.err);
    const key = p.serial;
    const alive = scrcpyProcs.get(key);
    if (alive && pidAlive(alive.pid)) return txt(`投屏已在运行（pid ${alive.pid}），如需重启请先 scrcpy_stop。`);

    const args = [
      "--serial", p.serial,
      "--max-size", String(opts.max_size ?? 1280),
      "--video-bit-rate", opts.bit_rate ?? "8M",
      "--max-fps", String(opts.max_fps ?? 60),
    ];
    if (opts.no_control) args.push("--no-control");
    if (opts.turn_screen_off) args.push("--turn-screen-off");
    if (opts.stay_awake) args.push("--stay-awake");
    if (opts.fullscreen) args.push("--fullscreen");
    if (opts.always_on_top) args.push("--always-on-top");
    if (opts.show_touches) args.push("--show-touches");
    if (opts.window_title) args.push("--window-title", opts.window_title);
    if (opts.record_file) args.push("--record", opts.record_file);
    if (opts.extra_args?.length) args.push(...opts.extra_args);

    const cwd = path.dirname(SCRCPY);
    const child = spawn(SCRCPY, args, { cwd, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    scrcpyProcs.set(key, { pid: child.pid, args, startedAt: new Date() });
    dbg("scrcpy spawn pid", child.pid, args.join(" "));
    return txt(
      `scrcpy 已启动（pid ${child.pid}）\n命令：scrcpy ${args.join(" ")}\n` +
      "用 scrcpy_status 查看状态、scrcpy_stop 停止。"
    );
  }
);

server.tool(
  "scrcpy_stop",
  "停止指定设备（或全部）的 scrcpy 投屏窗口。",
  { serial: serialOpt, all: z.boolean().optional().describe("停止所有投屏") },
  async ({ serial, all }) => {
    const targets = all || !serial ? [...scrcpyProcs.keys()] : [serial];
    if (!targets.length) return txt("没有记录中的投屏进程。");
    const out = [];
    for (const k of targets) {
      const rec = scrcpyProcs.get(k);
      if (!rec) { out.push(`${k}: 无记录`); continue; }
      if (pidAlive(rec.pid)) {
        await killTree(rec.pid);
        out.push(`${k}: 已停止（pid ${rec.pid}）`);
      } else {
        out.push(`${k}: 进程早已退出`);
      }
      scrcpyProcs.delete(k);
    }
    return txt(out.join("\n"));
  }
);

server.tool(
  "scrcpy_status",
  "查看当前有哪些 scrcpy 投屏在运行。",
  {},
  async () => {
    if (!scrcpyProcs.size) return txt("当前没有由本服务启动的投屏进程。");
    const lines = [];
    for (const [k, v] of scrcpyProcs) {
      lines.push(
        `- ${k}  pid=${v.pid}  ${pidAlive(v.pid) ? "运行中" : "已退出"}  启动于 ${v.startedAt.toLocaleTimeString()}\n  参数：${v.args.join(" ")}`
      );
    }
    return txt(lines.join("\n"));
  }
);

/* ---------------- 无线连接 ---------------- */

server.tool(
  "connect_wifi",
  "无线调试连接：先用 USB 连着手机，执行后即可拔线。会设置 tcpip 端口并 connect。",
  {
    ip: z.string().describe("手机在 WiFi 下的 IP，例如 192.168.1.20"),
    port: z.number().optional().describe("端口，默认 5555"),
    serial: serialOpt,
    skip_tcpip: z.boolean().optional().describe("已经开启过 tcpip 时可跳过设置步骤"),
  },
  async ({ ip, port, serial, skip_tcpip }) => {
    const portNum = port ?? 5555;
    if (!skip_tcpip) {
      const p = await pickSerial(serial);
      if (p.err) return errText(p.err + "\n（首次开启无线调试必须先用 USB 连着手机）");
      const t = await adb(["tcpip", String(portNum)], p.serial, { timeout: 20000 });
      if (!t.ok) return errText(`adb tcpip 失败：${t.stderr || t.stdout}`);
    }
    const c = await run(ADB, ["connect", `${ip}:${portNum}`], { timeout: 25000 });
    const devs = await listSerials();
    return txt(
      [`connect ${ip}:${portNum}: ${(c.stdout || c.stderr).trim()}`, "当前设备："].join("\n") +
        "\n" +
        devs.map((d) => `  ${d.serial} [${d.state}]`).join("\n")
    );
  }
);

server.tool(
  "adb_pair",
  "Android 11+ 无线配对：用手机「无线调试 → 使用配对码配对」显示的 IP、端口与配对码完成配对。",
  { ip: z.string(), pair_port: z.number().describe("手机显示的配对端口，如 37123"), code: z.string().describe("6 位配对码") },
  async ({ ip, pair_port, code }) => {
    const r = await run(ADB, ["pair", `${ip}:${pair_port}`, code], { timeout: 30000 });
    return txt(clip((r.stdout || "") + (r.stderr ? "\n" + r.stderr : "") || "配对完成"));
  }
);

server.tool(
  "disconnect",
  "断开无线设备连接。",
  { target: z.string().optional().describe("ip:port；不填则断开全部无线连接") },
  async ({ target }) => {
    const r = await run(ADB, ["disconnect", ...(target ? [target] : [])], { timeout: 20000 });
    return txt(clip(r.stdout || r.stderr || "已断开"));
  }
);

/* ==================================================================
 * 启动
 * ================================================================== */

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.mkdirSync(REC_DIR, { recursive: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  dbg(`server started. adb=${ADB} scrcpy=${SCRCPY} out=${OUT_DIR}`);
}

main().catch((e) => {
  process.stderr.write("启动失败: " + (e?.stack || e) + "\n");
  process.exit(1);
});
