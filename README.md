# adb-ai-mcp

让 AI 直接「看见」并操作你的 Android 手机 —— 一个基于 **ADB + scrcpy** 的 MCP 服务器。

> 把手机变成 AI 的一块屏幕：截图回传给模型、解析 UI 层级、点击滑动、装卸载应用、投屏到电脑、抓日志。
> 支持 USB 与 WiFi（无线调试），支持 Windows / macOS / Linux。

[English](./README_EN.md) | 中文 · [使用手册](./docs/USAGE.md)

---

## 它能干什么

装好之后，你可以直接用自然语言让 AI 操作手机：

- 「看看我手机现在屏幕上是什么」→ 截图回传，模型直接看图
- 「帮我把微信里的这个文件发给文件传输助手」→ `ui_dump` 找控件 → `tap` 点击 → 中文用 scrcpy 键盘输入
- 「把当前界面录 10 秒视频存到电脑」→ `record_screen`
- 「手机投到电脑上，我要演示」→ `scrcpy_start`
- 「帮我看看这个 App 崩溃的日志」→ `logcat` + 关键字过滤
- 「把手机照片全部拉到电脑 D 盘」→ `pull_file`

## 快速开始

### 1. 前置依赖

| 依赖 | 说明 | 安装 |
| --- | --- | --- |
| Node.js ≥ 18 | 运行 MCP 服务 | [nodejs.org](https://nodejs.org/) |
| ADB | Android 调试桥 | 装 Android SDK platform-tools，或单独下载 [platform-tools](https://developer.android.com/tools/releases/platform-tools) |
| scrcpy | 投屏（可选，仅投屏功能需要） | [github.com/Genymobile/scrcpy](https://github.com/Genymobile/scrcpy) |

手机端：设置 → 关于手机 → 连点版本号开启**开发者选项** → 打开 **USB 调试**。

### 2. 安装

**方式 A：npm 装（推荐，不用 clone）**

```bash
npm install -g adb-ai-mcp
```

**方式 B：从源码跑（要改代码时）**

```bash
git clone https://github.com/David-chinese-wei/adb-ai-mcp.git
cd adb-ai-mcp
npm install
```

### 3. 接入 MCP 客户端

**Claude Desktop** (`claude_desktop_config.json`)：

```json
{
  "mcpServers": {
    "adb-scrcpy": {
      "command": "npx",
      "args": ["-y", "adb-ai-mcp"],
      "env": {
        "ADB_EXE": "D:/platform-tools/adb.exe",
        "SCRCPY_EXE": "D:/scrcpy/scrcpy.exe"
      }
    }
  }
}
```

**Cursor / Cline / 其他支持 stdio MCP 的客户端**：配置结构相同，把 `command`/`args` 换成你自己的路径即可。

环境变量都是**可选的** —— 不填时会自动按 `ANDROID_HOME` / `ANDROID_SDK_ROOT` / 常见安装目录 / PATH 顺序探测。

### 4. 验证

```bash
npm run selftest
```

会真的连上手机跑一遍：环境体检、设备列表、设备信息、UI dump、截图、安全拦截等。

## 换一台电脑部署

如果走 npm 安装（`npm i -g adb-ai-mcp`），下面这些全都不用做，命令直接就能跑。

以下是**源码部署**的流程 —— 新机器上只要三步，不需要改任何代码：

```bash
# 1. 装依赖（Node ≥ 18 + adb；scrcpy 只影响投屏功能，可后装）
git clone https://github.com/David-chinese-wei/adb-ai-mcp.git
cd adb-ai-mcp
npm install

# 2. 告诉它 adb / scrcpy 在哪（可选）
cp .env.example .env        # 填 ADB_EXE、SCRCPY_EXE；留空则自动探测

# 3. 验证
npm run selftest
```

**关于第 2 步**：`.env` 是兜底，不是必须的。不填时会按
`ANDROID_HOME` / `ANDROID_SDK_ROOT` / 常见安装目录 / `PATH` 顺序自动找，
实测能自动找到 Android SDK 自带的 adb。只有 adb 装在不常规的位置时才需要手填。
（MCP 客户端里也可以通过 `env` 字段传，优先级高于 `.env`。）

已实测过的换机流程：全新目录 `git clone` → `npm install` → 不设任何环境变量 →
直接跑通设备识别、`device_info`、`ui_dump`、`screenshot`、`logcat`。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `ADB_EXE` / `ADB_PATH` | adb 可执行文件的绝对路径 |
| `SCRCPY_EXE` / `SCRCPY_PATH` | scrcpy 可执行文件的绝对路径 |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | Android SDK 根目录，用于探测 platform-tools |
| `ADB_SERIAL` | 默认设备序列号（多设备时省去每次指定） |
| `ADB_MCP_OUT_DIR` | 截图 / 录屏产物输出目录，默认项目下 `outputs/` |
| `ADB_MCP_DEBUG` | 设为 `1` 时把调试日志打到 stderr |

## 工具清单（30 个）

### 环境与连接
| 工具 | 说明 |
| --- | --- |
| `env_check` | 环境体检：adb/scrcpy 版本、设备状态、连接诊断 |
| `list_devices` | 列出设备与连接方式（USB / WiFi） |
| `set_default_device` | 设置默认设备，之后不必每次带 serial |
| `device_info` | 型号、Android 版本、分辨率、电量、内存、存储、IP |
| `restart_adb` | 重启 adb server（掉线时的万能第一步） |
| `connect_wifi` | 开启无线调试并连接（先插 USB 跑一次，之后可拔线） |
| `adb_pair` | Android 11+ 配对码配对 |
| `disconnect` | 断开无线连接 |

### 命令执行
| 工具 | 说明 |
| --- | --- |
| `shell` | 在设备上执行 shell 命令（含危险命令拦截） |
| `adb_cmd` | 执行任意 adb 主机端子命令 |
| `logcat` | 抓日志，支持关键字过滤与行数限制 |

### 应用
| 工具 | 说明 |
| --- | --- |
| `list_packages` | 列出应用包名（默认只看第三方） |
| `current_app` | 当前前台应用 / Activity |
| `start_app` | 启动应用（自动解析 Activity） |
| `stop_app` | 强制停止应用 |
| `install_apk` | 安装 APK |
| `uninstall_app` | 卸载应用（需确认） |
| `open_url` | 用浏览器打开网址 |

### 屏幕与交互
| 工具 | 说明 |
| --- | --- |
| `screenshot` | 截图并回传图片给模型（默认压到 720px 宽省 token） |
| `ui_dump` | 导出 UI 层级：文本、resource-id、可点状态、中心坐标 |
| `record_screen` | 录屏（最长 180s）并拉回电脑 |
| `tap` / `swipe` / `type_text` / `keyevent` | 点击 / 滑动 / 输入 / 按键 |

### 投屏与文件
| 工具 | 说明 |
| --- | --- |
| `scrcpy_start` | 启动投屏窗口（可调清晰度、码率、只读、关屏、录制） |
| `scrcpy_stop` / `scrcpy_status` | 停止 / 查看投屏 |
| `push_file` / `pull_file` | 电脑 ⇄ 手机互传文件 |

## 推荐工作流：AI 操作手机的三步循环

```
1. ui_dump      → 拿到当前界面所有控件及其中心坐标
2. 模型判断     → 决定点哪个元素
3. tap(x, y)    → 点击，再回到第 1 步
```

看不清时补一张 `screenshot`。需要输入中文时，改用 `scrcpy_start` 开投屏，用电脑键盘打字。

## 安全机制

AI 能删东西，所以命令分级拦截是内建的：

- **直接拒绝**：删系统分区、`dd` 写块设备、fastboot 擦除/解锁、recovery wipe、fork 炸弹
- **需二次确认**：`rm`、重启、卸载应用、改系统设置/属性、杀进程、`su` 提权
  —— 第一次调用会返回提示，带 `confirm: true` 再调一次才真正执行
- 所有输出都会截断，避免超长日志/目录列表冲爆上下文
- 截图默认压缩到 720px 宽，控制 token 消耗

## 排错

| 现象 | 处理 |
| --- | --- |
| `unauthorized` | 手机上点「允许 USB 调试」，勾选始终允许 |
| `offline` | 换线 / 重插 / 关开 USB 调试 / `restart_adb` |
| 找不到设备 | 跑 `env_check` 看 adb 路径与设备状态 |
| 多台设备报错 | 带 `serial` 参数，或 `set_default_device` 设一台默认 |
| 同一台手机出现两条记录 | 正常，USB + WiFi 双通道，工具会自动识别并选 USB |
| scrcpy 起不来 | 确认 scrcpy 版本 ≥ 2.0，且同目录或 PATH 里有 adb |

## 目录结构

```
adb-ai-mcp/
├── server.js          # MCP 服务主体（30 个工具）
├── selftest.mjs       # 自检客户端：真连设备跑一遍关键能力
├── docs/USAGE.md      # 场景使用手册
├── outputs/           # 截图与录屏产物（默认，已 gitignore）
└── package.json
```

## 开发

```bash
npm run selftest            # 真机自检
ADB_MCP_DEBUG=1 npm start   # 带 stderr 调试日志启动
```

## 许可证

[MIT](./LICENSE)
