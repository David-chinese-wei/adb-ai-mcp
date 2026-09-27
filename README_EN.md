# adb-ai-mcp

Let your AI **see and operate** an Android phone — an MCP server built on **ADB + scrcpy**.

> Turn the phone into a screen the model can look at: screenshot round-trip, UI hierarchy parsing,
> tap & swipe, app install/uninstall, screen mirroring, logcat.
> Works over USB and WiFi (wireless debugging). Windows / macOS / Linux.

中文 | [English](./README.md) · [Usage guide (中文)](./docs/USAGE.md)

---

## What it enables

Once connected, you can just talk to the phone:

- "What's on my screen right now?" → screenshot is sent back to the model as an image
- "Send that file to File Transfer in WeChat" → `ui_dump` to locate it → `tap` → type via scrcpy keyboard
- "Record 10 seconds and save it to my PC" → `record_screen`
- "Mirror my phone, I'm doing a demo" → `scrcpy_start`
- "Why does this app crash?" → `logcat` with keyword filtering
- "Pull all photos to my PC" → `pull_file`

## Quick start

### 1. Prerequisites

| Dep | Note | Install |
| --- | --- | --- |
| Node.js ≥ 18 | runs the MCP server | [nodejs.org](https://nodejs.org/) |
| ADB | Android Debug Bridge | Android SDK platform-tools, or [standalone download](https://developer.android.com/tools/releases/platform-tools) |
| scrcpy | mirroring (optional) | [github.com/Genymobile/scrcpy](https://github.com/Genymobile/scrcpy) |

On the phone: Settings → About → tap build number 7× to unlock **Developer options** → enable **USB debugging**.

### 2. Install

**Option A: via npm (recommended, no clone needed)**

```bash
npm install -g adb-ai-mcp
```

**Option B: from source (for development)**

```bash
git clone https://github.com/David-chinese-wei/adb-mcp.git
cd adb-mcp
npm install
```

### 3. Wire it into your MCP client

**Claude Desktop** (`claude_desktop_config.json`):

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

**Cursor / Cline / any stdio MCP client**: same shape, swap in your own paths.

All env vars are **optional** — when omitted, binaries are auto-detected from `ANDROID_HOME` /
`ANDROID_SDK_ROOT` / common install locations / `PATH`.

### 4. Verify

```bash
npm run selftest
```

This really connects to your phone and exercises env check, device list, device info,
UI dump, screenshot, and the safety guard.

## Deploying on another machine

Three steps, no code changes:

```bash
# 1. deps (Node ≥ 18 + adb; scrcpy is only needed for mirroring)
git clone https://github.com/David-chinese-wei/adb-mcp.git
cd adb-mcp
npm install

# 2. point it at adb / scrcpy (optional)
cp .env.example .env        # fill ADB_EXE, SCRCPY_EXE; leave blank to auto-detect

# 3. verify
npm run selftest
```

Step 2 is a fallback, not a requirement: binaries are auto-detected from `ANDROID_HOME` /
`ANDROID_SDK_ROOT` / common install locations / `PATH` — in testing it found the
Android SDK's own adb with zero configuration. Only fill `.env` if adb lives somewhere unusual.
(An `env` block in your MCP client takes priority over `.env`.)

Verified end-to-end on a clean checkout: `git clone` → `npm install` → no env vars →
device detection, `device_info`, `ui_dump`, `screenshot` and `logcat` all worked.

## Environment variables

| Var | Purpose |
| --- | --- |
| `ADB_EXE` / `ADB_PATH` | absolute path to adb |
| `SCRCPY_EXE` / `SCRCPY_PATH` | absolute path to scrcpy |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | Android SDK root, used to find platform-tools |
| `ADB_SERIAL` | default device serial (skips passing `serial` every call) |
| `ADB_MCP_OUT_DIR` | output dir for screenshots/recordings, default `outputs/` |
| `ADB_MCP_DEBUG` | set to `1` for debug logs on stderr |

## Tools (30)

### Environment & connection
`env_check` · `list_devices` · `set_default_device` · `device_info` · `restart_adb` · `connect_wifi` · `adb_pair` · `disconnect`

### Command execution
`shell` (guarded) · `adb_cmd` · `logcat`

### Apps
`list_packages` · `current_app` · `start_app` · `stop_app` · `install_apk` · `uninstall_app` · `open_url`

### Screen & interaction
`screenshot` (image returned to the model) · `ui_dump` · `record_screen` · `tap` · `swipe` · `type_text` · `keyevent`

### Mirroring & files
`scrcpy_start` · `scrcpy_stop` · `scrcpy_status` · `push_file` · `pull_file`

## Recommended loop for agentic control

```
1. ui_dump    →  get every element with its center coordinates
2. reason     →  decide which element to hit
3. tap(x, y)  →  tap, then go back to step 1
```

Fall back to `screenshot` when the hierarchy isn't enough. For CJK input, start scrcpy and
type with your physical keyboard — `adb input text` is ASCII-only.

## Safety

The AI can delete things, so command guardrails are built in:

- **Hard block**: deleting system partitions, `dd` to block devices, fastboot erase/unlock, recovery wipe, fork bombs
- **Requires confirmation**: `rm`, reboot, uninstall, settings/property changes, killing processes, `su`
  — the first call returns a notice; re-call with `confirm: true` to actually run it
- Every output is truncated so giant logs or directory listings can't blow up the context
- Screenshots are downscaled to 720px wide by default to keep token cost sane

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `unauthorized` | tap "Allow USB debugging" on the phone |
| `offline` | swap cable / replug / toggle USB debugging / `restart_adb` |
| no device found | run `env_check` to see adb path and device state |
| "multiple devices" error | pass `serial`, or `set_default_device` once |
| one phone listed twice | normal — USB + WiFi; the server auto-detects and prefers USB |
| scrcpy won't start | need scrcpy ≥ 2.0 with adb alongside it or on PATH |

## Layout

```
adb-ai-mcp/
├── server.js        # MCP server: 30 tools
├── selftest.mjs     # self-test client that drives a real device
├── docs/USAGE.md    # scenario handbook
├── outputs/         # screenshots & recordings (gitignored)
└── package.json
```

## Development

```bash
npm run selftest            # real-device self test
ADB_MCP_DEBUG=1 npm start   # start with stderr debug logging
```

## License

[MIT](./LICENSE)
