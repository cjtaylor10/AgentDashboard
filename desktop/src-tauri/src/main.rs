// Prevents an additional console window from appearing on Windows in release.
// Remove this if you need a console window for debugging.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agent_dashboard_lib::run()
}
