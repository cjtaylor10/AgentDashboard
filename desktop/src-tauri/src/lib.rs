// AgentDashboard — Tauri 2 application entry point.
//
// This is a thin desktop wrapper: all UI is served by the sidecar cockpit at
// http://localhost:4317. Start the cockpit first (`npm run cockpit` in sidecar/),
// then launch this app (`cargo tauri dev` in desktop/src-tauri/).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running AgentDashboard desktop app");
}
