# AgentDashboard — Desktop Wrapper

> **SCAFFOLD ONLY** — this directory contains an unbuilt Tauri 2 skeleton.
> No native build has been run; no binary has been produced.
> A human must complete the Rust/Tauri toolchain setup and verify the build.

This is a Tauri 2 desktop wrapper that points a native window at the sidecar
cockpit web UI (`http://localhost:4317`). All application logic lives in the
sidecar; this wrapper adds OS chrome (title bar, window management, optional
system tray) without duplicating any backend code.

## Prerequisites

1. **Rust toolchain** — install via [rustup](https://rustup.rs/):
   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup update stable
   ```

2. **Tauri CLI v2** — install via Cargo:
   ```sh
   cargo install tauri-cli --version "^2"
   ```

3. **Platform system dependencies** — Tauri requires native WebView libraries:
   - **Linux**: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, and
     the other packages listed in the
     [Tauri Linux prerequisites](https://tauri.app/start/prerequisites/#linux).
   - **macOS**: Xcode Command Line Tools (`xcode-select --install`).
   - **Windows**: Microsoft Edge WebView2 (ships with Windows 10/11; if absent,
     download the Evergreen installer from Microsoft).

## Run steps

Open two terminals:

**Terminal 1 — start the cockpit** (must be running before you launch the desktop app):
```sh
cd sidecar
npm run cockpit
# Cockpit is now live at http://localhost:4317
```

**Terminal 2 — launch the desktop app in development mode**:
```sh
cd desktop/src-tauri
cargo tauri dev
```

A native window titled **AgentDashboard** (1280 x 800) will open and load the
cockpit UI. Hot-reload is not needed here because the UI is served by the
already-running cockpit process.

## Production build

```sh
cd desktop/src-tauri
cargo tauri build
```

The distributable is written to `desktop/src-tauri/target/release/bundle/`.

## Layout

```
desktop/
  README.md               this file
  src-tauri/
    build.rs              tauri-build hook (required by Tauri 2)
    Cargo.toml            Rust package + Tauri 2 dependencies
    tauri.conf.json       Tauri 2 app config (window title, size, dev URL)
    src/
      main.rs             binary entry point (sets Windows subsystem flag)
      lib.rs              Tauri builder — plugin init + context generation
```

## Notes

- The cockpit port is hardcoded to `4317` in both `sidecar/src/server.js` and
  `tauri.conf.json` (`build.frontendDist`). If you change the port via
  `COCKPIT_PORT`, update `tauri.conf.json` accordingly.
- This scaffold was generated without running `cargo`/`tauri`; the first
  `cargo tauri dev` will fetch and compile all Rust dependencies from crates.io.
  Expect a multi-minute cold build.
