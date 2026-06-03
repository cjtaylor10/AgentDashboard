// AgentDashboard — Tauri 2 application entry point.
//
// This is a thin desktop wrapper: all UI is served by the sidecar cockpit at
// http://localhost:4317. Unlike the old two-terminal flow, this app now:
//   1. Auto-starts the Node cockpit as a managed child process on launch
//      (and tears it down on exit), so the user only runs the desktop app.
//   2. Checks GitHub Releases for an update on startup and installs it in the
//      background, Claude-Desktop style.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Holds the running cockpit child process so it can be killed on app exit.
/// Wrapped in a Mutex<Option<..>> because `CommandChild::kill` consumes `self`,
/// so we `take()` it out of the Option when terminating.
struct CockpitProcess(Mutex<Option<CommandChild>>);

/// Locate the repo's `sidecar/` directory relative to the running app.
///
/// Two repos/layouts must work:
///   - `cargo tauri dev`: the binary runs from `desktop/src-tauri/`, so the
///     sidecar lives at `../../sidecar`.
///   - A bundled/installed build: there is no fixed path back to the source
///     tree, so we probe a list of plausible locations relative to both the
///     executable and the current working directory, and pick the first that
///     actually contains `scripts/cockpit.js`.
fn resolve_sidecar_dir() -> Option<PathBuf> {
    // Candidate roots to search, in priority order.
    let mut roots: Vec<PathBuf> = Vec::new();

    // 1. The directory containing the running executable, plus its ancestors.
    //    From `desktop/src-tauri/target/<profile>/app.exe`, the repo root is a
    //    few levels up; from an installed app the sidecar may sit beside it.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            roots.push(exe_dir.to_path_buf());
            // Walk up to 6 ancestors to reach the repo root in a dev tree
            // (target/<profile>/ -> src-tauri/ -> desktop/ -> <repo>/).
            let mut cur = exe_dir;
            for _ in 0..6 {
                if let Some(parent) = cur.parent() {
                    roots.push(parent.to_path_buf());
                    cur = parent;
                } else {
                    break;
                }
            }
        }
    }

    // 2. The current working directory and a couple of its ancestors. Covers
    //    `cargo tauri dev`, which sets cwd to `desktop/src-tauri/`.
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.clone());
        let mut cur = cwd.as_path();
        for _ in 0..4 {
            if let Some(parent) = cur.parent() {
                roots.push(parent.to_path_buf());
                cur = parent;
            } else {
                break;
            }
        }
    }

    // For each candidate root, try the root itself and a set of relative
    // offsets that could point at the repo's `sidecar/` folder.
    let offsets: [&[&str]; 6] = [
        &[],                         // root *is* the sidecar dir
        &["sidecar"],                // root is the repo
        &["..", "sidecar"],          // root is `desktop/`
        &["..", "..", "sidecar"],    // root is `desktop/src-tauri/`
        &["..", "..", "..", "sidecar"], // deeper nesting (e.g. target/<profile>/)
        &["resources", "sidecar"],   // a bundled layout that ships the sidecar as a resource
    ];

    for root in &roots {
        for offset in offsets.iter() {
            let mut candidate = root.clone();
            for part in offset.iter() {
                candidate.push(part);
            }
            if is_sidecar_dir(&candidate) {
                // Normalize away the `..` segments where possible.
                return Some(candidate.canonicalize().unwrap_or(candidate));
            }
        }
    }

    None
}

/// A directory is the sidecar root iff it contains `scripts/cockpit.js`.
fn is_sidecar_dir(dir: &Path) -> bool {
    dir.join("scripts").join("cockpit.js").is_file()
}

/// Spawn `node --no-warnings scripts/cockpit.js` with cwd = the sidecar folder,
/// and stash the child handle in managed state so we can kill it on exit.
fn start_cockpit(app: &tauri::AppHandle) {
    // Prefer the sidecar bundled as an app resource (resource_dir/sidecar, present in a
    // packaged install); fall back to dev-tree probing for `cargo tauri dev`.
    let sidecar_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| r.join("sidecar"))
        .filter(|p| is_sidecar_dir(p))
        .or_else(resolve_sidecar_dir);
    let sidecar_dir = match sidecar_dir {
        Some(dir) => dir,
        None => {
            eprintln!(
                "[desktop] could not locate the sidecar/ folder (looked for scripts/cockpit.js); \
                 the cockpit was NOT started. Start it manually with `npm run cockpit`."
            );
            return;
        }
    };

    // The packaged app's resources are read-only, so the cockpit must write its SQLite db
    // to a writable per-user location, passed via AGENTDASH_DATA_DIR (read by config.js).
    let data_dir = app.path().app_data_dir().ok().map(|d| d.join("data"));

    let shell = app.shell();
    let mut command = shell
        .command("node")
        .args(["--no-warnings", "scripts/cockpit.js"])
        .current_dir(&sidecar_dir);
    if let Some(dd) = &data_dir {
        let _ = std::fs::create_dir_all(dd);
        command = command.env("AGENTDASH_DATA_DIR", dd.to_string_lossy().to_string());
    }

    match command.spawn() {
        Ok((mut rx, child)) => {
            eprintln!(
                "[desktop] started cockpit: node --no-warnings scripts/cockpit.js (cwd: {})",
                sidecar_dir.display()
            );

            // Store the child so the exit handler can terminate it.
            if let Some(state) = app.try_state::<CockpitProcess>() {
                *state.0.lock().unwrap() = Some(child);
            }

            // Drain the cockpit's stdout/stderr to the desktop console so its
            // logs are visible and the OS pipe buffer never fills up (which
            // would otherwise block the Node process).
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            eprint!("[cockpit] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprint!("[cockpit] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Error(err) => {
                            eprintln!("[cockpit] process error: {}", err);
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[cockpit] exited: {:?}", payload);
                            break;
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(err) => {
            eprintln!(
                "[desktop] failed to start cockpit (is Node on PATH?): {}. \
                 Start it manually with `npm run cockpit` in {}.",
                err,
                sidecar_dir.display()
            );
        }
    }
}

/// Kill the managed cockpit child, if any. Safe to call multiple times.
fn stop_cockpit(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<CockpitProcess>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            eprintln!("[desktop] stopping cockpit child process…");
            let _ = child.kill();
        }
    }
}

/// Check GitHub Releases for an update and, if one is available, download and
/// install it in the background. Runs on startup; failures are non-fatal (the
/// app keeps running on the current version).
#[cfg(desktop)]
fn check_for_updates(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(err) => {
                eprintln!("[updater] could not initialize updater: {}", err);
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                eprintln!(
                    "[updater] update available: {} -> {}; downloading…",
                    update.current_version, version
                );

                let mut downloaded: usize = 0;
                let result = update
                    .download_and_install(
                        |chunk_len, content_len| {
                            downloaded += chunk_len;
                            if let Some(total) = content_len {
                                eprintln!("[updater] downloaded {downloaded}/{total} bytes");
                            }
                        },
                        || {
                            eprintln!("[updater] download finished; installing…");
                        },
                    )
                    .await;

                match result {
                    Ok(_) => {
                        eprintln!(
                            "[updater] update {} installed; it will apply on next launch.",
                            version
                        );
                    }
                    Err(err) => {
                        eprintln!("[updater] failed to download/install update: {}", err);
                    }
                }
            }
            Ok(None) => {
                eprintln!("[updater] no update available; running the latest version.");
            }
            Err(err) => {
                eprintln!("[updater] update check failed: {}", err);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is only needed when the desktop-only updater plugin is added below;
    // allow it to stay clean on mobile targets where that branch is compiled out.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());

    // The updater plugin is desktop-only.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            // Managed state to hold the cockpit child handle.
            app.manage(CockpitProcess(Mutex::new(None)));

            // 1. Auto-start the Node cockpit (serves the web UI on :4317).
            //    `app.handle()` already yields `&AppHandle`.
            start_cockpit(app.handle());

            // 2. Kick off the background update check (desktop only).
            #[cfg(desktop)]
            check_for_updates(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AgentDashboard desktop app")
        .run(|app_handle, event| {
            // Terminate the cockpit child when the app is shutting down.
            match event {
                RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                    stop_cockpit(app_handle);
                }
                _ => {}
            }
        });
}
