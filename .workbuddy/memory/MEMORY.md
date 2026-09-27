# 项目长期记忆：adb-ai-mcp

## 项目是什么
ADB + scrcpy 的 MCP 服务器，让 AI「看见」并操作 Android 手机。单个 `server.js`（ESM，约 47KB）+ `selftest.mjs`。
30 个工具，分六组：环境/连接、命令执行、应用、屏幕与交互、投屏、文件传输。

## 关键约定
- **零私有路径**：adb / scrcpy 靠 `ADB_EXE` / `SCRCPY_EXE` / `ANDROID_HOME` + 跨平台常见目录 + PATH 探测，
  代码里禁止出现本机绝对路径（要开源）。
- **安全三级拦截**：硬拒绝（删系统分区 / dd 写块设备 / fastboot erase / wipe / fork 炸弹）；
  需二次确认（`rm`、重启、卸载、改系统设置、`su`，第一次返回提示，带 `confirm: true` 才执行）；其余放行。
- **省 token**：截图默认压到 720px 宽，所有输出自动截断。
- 手机 USB + WiFi 双通道时 ADB 报两台设备，靠 `ro.serialno` 识别并自动优先 USB —— 这是刻意设计，别当 bug 改。
- 中文输入必须走 scrcpy 投屏键盘（`type_text` 走 ADB 输入法不支持中文），USAGE.md 里已写。

## 仓库与发布
- GitHub：`David-chinese-wei/adb-mcp`（main 分支，CI 在 `.github/workflows/ci.yml`）。
- npm 包名：`adb-ai-mcp`（`adb-mcp` 已被占用）。本机 npm 未登录，发布需用户先 `npm login`。
- 二者命名不一致，用户尚未决定是否改仓库名。

## 本机环境
- 手机：HUAWEI EML-AL00 / Android 10 / 1080x2244。
- adb 在 Android SDK 默认目录 `C:\Users\Administrator\AppData\Local\Android\Sdk\platform-tools`（可自动探测到）。
- MCP 客户端配置在 `~/.workbuddy/mcp.json`（server 名 `adb-scrcpy`），改动路径后需在连接器管理页点「信任」才生效。
- git 无全局 user 配置，新 clone 的目录首次提交前要先设 `git config user.name/email`（用 `David-chinese-wei <noreply@github.com>`）。
