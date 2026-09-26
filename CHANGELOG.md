# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-09-26

### Added
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

### Notes
- When a phone is connected both via USB and WiFi, ADB reports it as two devices.
  The server detects this via `ro.serialno` and automatically prefers the USB transport.
