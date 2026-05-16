# Changelog

All notable changes to this project will be documented here.

---

## [2.0.3] - 2026-05-17

### Added
- **Sleep Mode switch** — HomeKit's `AirPurifier` service only supports Auto/Manual states, so sleep mode is now exposed as a dedicated `Switch` service labelled "Sleep Mode". It stays in sync with the device at all times (including physical control changes) and when activated it sets the purifier to sleep mode and turns the display light off.

---

## [2.0.2] - 2026-05-16

### Fixed
- Version bump to align with npm registry state after resolving restricted-access issue on initial publish (2.0.0 and 2.0.1 were published as private packages).

---

## [2.0.1] - 2026-05-16

### Changed
- Package renamed to scoped name `@maddogwarner/homebridge-philips-air-purifier` for npm publish.
- README install instructions updated to reference the new scoped package name.
- `repository` URL corrected to `git+https://` format required by npm.

---

## [2.0.0] - 2026-05-16 *(MaddogWarner fork — first release)*

Forked from [louiscrc/homebridge-philips-air-purifier](https://github.com/louiscrc/homebridge-philips-air-purifier) and updated for Homebridge 2.0+ and Node.js 24.

### Changed — Homebridge 2.0+ API
- `api.registerAccessory()` updated to 2-argument form (plugin name prefix removed).
- Constructor updated to accept `api` parameter; `Service` and `Characteristic` now sourced from `api.hap`.
- All `.on('get')` / `.on('set')` characteristic handlers replaced with `onGet` / `onSet`.
- `identify()` callback argument removed (Homebridge 2.0 no longer passes one).
- `HapStatusError` now thrown on command failures instead of raw errors.
- `updateCharacteristic()` used in place of `getCharacteristic().updateValue()`.

### Changed — Node.js 24 compatibility
- All built-in module `require()` calls updated to use the `node:` prefix (`node:child_process`, `node:readline`, `node:path`, `node:fs`).

### Changed — Python daemon
- `asyncio.get_event_loop()` replaced with `asyncio.get_running_loop()` inside async contexts, fixing deprecation warnings on Python 3.10+ and removal errors on Python 3.12+.

### Added
- Daemon auto-restart with exponential backoff (5 s → 10 s → 30 s → 60 s) on unexpected daemon exit.

### Fixed
- Filter life and cleanup percentages that are exactly 0% no longer incorrectly default to 100% (replaced `||` with `??`).
- `package.json` `engines` and `peerDependencies` bumped to `homebridge >=2.0.0`.
- README updated: fork notice added at top, credits section updated, issue tracker URL updated to this fork.

---

## [1.x] — Original by louiscrc

### [2.0.0-louiscrc] - 2026-01-06
- Switched from HTTP polling to **CoAP Observe** for real-time push updates from device (~every 30 s or on change).
- Commands (power, mode, light, child lock) complete in ~100–300 ms via direct CoAP control.
- Added child lock support.
- Improved service linking for HomeKit.
- General reliability and responsiveness improvements.

### Earlier releases
See the [original repository](https://github.com/louiscrc/homebridge-philips-air-purifier) for history prior to the CoAP Observe rewrite.
