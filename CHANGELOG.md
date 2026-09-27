# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.0] - 2026-09-27

### Added
- Published as npm package `adb-ai-mcp` (`npm i -g adb-ai-mcp`, or `npx adb-ai-mcp`).
  Added `files` whitelist, `engines.node >= 18`, `publishConfig.access=public`,
  and a `bin` entry so the server runs as a CLI command.
- `docs/USAGE.md`: scenario-based manual (first connection, the ui_dump → tap loop,
  mirroring, logcat, multi-device, known limits).
- Project-root `.env` fallback so a fresh checkout runs without touching client config.
- `package-lock.json` is now committed for reproducible installs.
- selftest honors `ADB_MCP_SELFTEST_SKIP_MIRROR=1` to skip the scrcpy window.
- MCP server over stdio with 30 tools for phone ⇄ PC control.
- Environment check: adb/scrcpy detection, versions, device states, connection diagnosis.
- Device management: list, info, default device, multi-device handling.
- ADB command execution with three-tier safety guard (allow / confirm / block).
- App management: list, current app, start, stop, install, uninstall, open URL.
- Screen: screenshot (image returned to the model, auto-downscaled), UI hierarchy dump,
  screen recording, tap / swipe / text / keyevent.
- scrcpy mirroring: start / stop / status, USB and WiFi.
- Wireless debugging: `connect_wifi`, Android 11+ `adb_pair`, `disconnect`.
- File transfer between PC and phone.
- `selftest.mjs`: real-device self test driven through an actual MCP client.
- Cross-platform binary detection with no hardcoded private paths.

### Fixed
- `.env` values were shadowed by an earlier empty entry for the same key.

### Notes
- When a phone is connected both via USB and WiFi, ADB reports it as two devices.
  The server detects this via `ro.serialno` and automatically prefers the USB transport.
