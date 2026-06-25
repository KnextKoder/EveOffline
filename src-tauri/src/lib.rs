use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use std::sync::Mutex;

struct SidecarState(Mutex<Option<CommandChild>>);

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            // In dev, the exe lives at src-tauri/target/debug/eve-offline.exe
            // Navigate up 3 levels (debug → target → src-tauri) to reach the project root.
            // In release, resources are bundled by Tauri into resource_dir which already
            // contains the sidecar/ directory.
            #[cfg(debug_assertions)]
            let work_dir = std::env::current_exe()
                .expect("failed to get exe path")
                .parent().and_then(|p| p.parent()).and_then(|p| p.parent()).and_then(|p| p.parent())
                .expect("could not navigate to project root from exe")
                .to_path_buf();

            #[cfg(not(debug_assertions))]
            let work_dir = app
                .path()
                .resource_dir()
                .expect("failed to resolve resource dir");

            let script = work_dir.join("sidecar").join("index.ts");

            println!("Spawning sidecar: bun {}", script.display());
            println!("Working directory: {}", work_dir.display());

            let (mut rx, child) = app
                .shell()
                .sidecar("bun")
                .expect("bun sidecar not configured in tauri.conf.json")
                .args([script.to_str().expect("script path is not valid UTF-8")])
                .env("EVE_RESOURCE_DIR", work_dir.to_str().unwrap_or(""))
                .current_dir(&work_dir)
                .spawn()
                .expect("failed to spawn bun sidecar");

            // Pipe sidecar stdout/stderr into the Rust console
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            print!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprint!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        _ => {}
                    }
                }
            });

            *app.state::<SidecarState>().0.lock().unwrap() = Some(child);

            println!("Eve sidecar spawned via bun");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let child = window.state::<SidecarState>().0.lock().unwrap().take();
                if let Some(child) = child {
                    let _ = child.kill();
                    println!("Eve sidecar killed");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
