# Installing AgentDashboard

There are two ways to run AgentDashboard:

- **Path 1 — Developer mode** runs the sidecar and the web cockpit directly from source. It works today on **Windows and macOS** and is the recommended way to try the harness.
- **Path 2 — Desktop app** installs a native window (Windows `.msi` / macOS `.dmg`) that wraps the same cockpit, with built-in click-to-update.

## Prerequisites (both paths)

1. **Claude Code**, installed and **logged into a Claude subscription.** The harness spawns the `claude` CLI as its worker and authenticates through your existing login via OAuth — **no `ANTHROPIC_API_KEY` is needed.** Verify with:
   - Windows (PowerShell): `claude --version`
   - macOS (Terminal): `claude --version`
2. **Node.js 24 or newer.** Verify with `node --version` (it must print `v24.` or higher).

> The harness **auto-detects the `claude` binary on your PATH** (and common install locations). If yours lives somewhere unusual, point the harness at it with the **`CLAUDE_BIN`** environment variable (see the note at the end of each path).

---

## Path 1 — Developer mode (Windows and macOS)

### Windows (PowerShell)

1. Clone the repository:
   ```powershell
   git clone https://github.com/cjtaylor10/AgentDashboard
   ```
2. Enter the sidecar folder:
   ```powershell
   cd AgentDashboard\sidecar
   ```
3. Start the cockpit server (no `npm install` is required — the sidecar has zero dependencies):
   ```powershell
   npm run cockpit
   ```
4. Open the dashboard in your browser:
   ```
   http://localhost:4317
   ```
5. To watch the org improve itself, open a **second** PowerShell window in the same `sidecar` folder and run one self-improvement cycle:
   ```powershell
   npm run autonomous
   ```
   Management picks the next improvement, the council builds it, and the gate decides whether it merges — all live in the cockpit.

If you need to override the worker binary location, set it before running (current PowerShell session only):
```powershell
$env:CLAUDE_BIN = "C:\path\to\claude.exe"
```

### macOS (Terminal)

1. Clone the repository:
   ```bash
   git clone https://github.com/cjtaylor10/AgentDashboard
   ```
2. Enter the sidecar folder:
   ```bash
   cd AgentDashboard/sidecar
   ```
3. Start the cockpit server (no `npm install` is required — the sidecar has zero dependencies):
   ```bash
   npm run cockpit
   ```
4. Open the dashboard in your browser:
   ```
   http://localhost:4317
   ```
5. To watch the org improve itself, open a **second** Terminal tab in the same `sidecar` folder and run one self-improvement cycle:
   ```bash
   npm run autonomous
   ```
   Management picks the next improvement, the council builds it, and the gate decides whether it merges — all live in the cockpit.

If you need to override the worker binary location, set it before running (current shell session only):
```bash
export CLAUDE_BIN="/path/to/claude"
```

> **Port note:** the cockpit listens on **4317** by default. To use a different port, set `COCKPIT_PORT` (e.g. PowerShell `$env:COCKPIT_PORT = "5000"`, macOS `export COCKPIT_PORT=5000`) and open that port instead.

---

## Path 2 — Desktop app (native window with auto-update)

The desktop app is a Tauri 2 build that opens a native window pointed at the local cockpit. CI builds the installers from version tags, so each tagged release publishes a Windows `.msi` and a macOS `.dmg` to **GitHub Releases**, with built-in click-to-update.

> The desktop app still runs the worker through your local `claude` CLI, so the **Prerequisites above (Claude Code logged in, Node 24+) still apply.**

### Windows

1. Open the project's **Releases** page:
   ```
   https://github.com/cjtaylor10/AgentDashboard/releases
   ```
2. Under the latest release, download the **`.msi`** installer.
3. Run the downloaded `.msi` and follow the installer prompts.
4. Launch **AgentDashboard** from the Start menu. The native window opens on the live cockpit.
5. When a newer version is published, accept the built-in **update** prompt to upgrade in place.

### macOS

1. Open the project's **Releases** page:
   ```
   https://github.com/cjtaylor10/AgentDashboard/releases
   ```
2. Under the latest release, download the **`.dmg`** image.
3. Open the `.dmg` and drag **AgentDashboard** into your **Applications** folder.
4. Launch **AgentDashboard** from Applications. The native window opens on the live cockpit.
5. When a newer version is published, accept the built-in **update** prompt to upgrade in place.

> As in Developer mode, the app **auto-detects `claude` on your PATH**; if needed, override it with the **`CLAUDE_BIN`** environment variable before launching the app.

---

## Verifying your install

- The cockpit loads at **http://localhost:4317** and the connection indicator shows live (Server-Sent-Events streaming).
- Running `npm run autonomous` produces activity in the cockpit: tickets appear on the board, agents act in the chat/console, and a change is either merged or withheld by the gate.
- If a cycle reports the worker is missing, confirm `claude --version` works and, if necessary, set **`CLAUDE_BIN`** to the full path of your `claude` binary.
