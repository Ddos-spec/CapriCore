mod win_auto;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{PhysicalPosition, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub struct UiState {
    pub asset_base_url: String,
    pub assets_dir: PathBuf,
    pub brain_url: String,
    pub brain_mode: String,
    pub hit_rects: Arc<Mutex<Vec<HitRect>>>,
    pub click_through_locked: Arc<AtomicBool>,
    pub dragging_active: Arc<AtomicBool>,
}

#[tauri::command]
fn get_runtime_config(state: State<'_, UiState>) -> Value {
    let manifest_path = state
        .assets_dir
        .join("capri/sprites/v1/runtime-sprite-set.json");
    let manifest: Value = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({ "sprites": [] }));

    json!({
        "brainUrl": state.brain_url,
        "brainMode": state.brain_mode,
        "assetBaseUrl": state.asset_base_url,
        "assetsDir": state.assets_dir.display().to_string(),
        "manifest": manifest,
        "fullAccess": true
    })
}

#[tauri::command]
fn update_hit_rects(state: State<'_, UiState>, rects: Vec<HitRect>) {
    if let Ok(mut g) = state.hit_rects.lock() {
        *g = rects;
    }
}

#[tauri::command]
fn set_dragging(state: State<'_, UiState>, window: tauri::WebviewWindow, active: bool) -> Result<(), String> {
    state.dragging_active.store(active, Ordering::Relaxed);
    if active {
        let _ = window.set_ignore_cursor_events(false);
        let _ = window.start_dragging();
        state.dragging_active.store(false, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn set_click_through(state: State<'_, UiState>, window: tauri::WebviewWindow, ignore: bool) -> Result<(), String> {
    state.click_through_locked.store(ignore, Ordering::Relaxed);
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn capture_screen_b64() -> Result<Value, String> {
    let (data_url, w, h) = win_auto::capture_screen_data_url().map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "dataUrl": data_url, "width": w, "height": h }))
}

#[tauri::command]
fn exec_desktop_action(args: Value) -> Result<Value, String> {
    win_auto::execute_desktop_action(&args).map_err(|e| e.to_string())
}

#[tauri::command]
fn auto_perch_window(window: tauri::WebviewWindow) -> Result<Value, String> {
    let wins = win_auto::list_top_windows();
    let Some(target) = wins.first() else {
        return Ok(json!({ "ok": false, "reason": "no_target_window" }));
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let win_w = (360.0 * scale).round() as i32;
    let win_h = (420.0 * scale).round() as i32;
    let (screen_w, screen_h) = win_auto::get_primary_screen_rect();

    // Perch on top-right corner of the active target window cleanly within screen bounds
    let target_x = (target.x + target.width - win_w - 12).clamp(0, (screen_w - win_w).max(0));
    let target_y = (target.y - (win_h as f64 * 0.42).round() as i32)
        .clamp(0, (screen_h - win_h).max(0));

    window
        .set_position(PhysicalPosition::new(target_x, target_y))
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "ok": true,
        "targetTitle": target.title,
        "x": target_x,
        "y": target_y
    }))
}

#[tauri::command]
fn move_to_bottom_right(window: tauri::WebviewWindow) -> Result<Value, String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let win_w = (360.0 * scale).round() as i32;
    let win_h = (420.0 * scale).round() as i32;
    let (screen_w, screen_h) = win_auto::get_primary_screen_rect();
    let x = (screen_w - win_w - 18).max(0);
    let y = (screen_h - win_h - 46).max(0);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "x": x, "y": y }))
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn resolve_assets_dir() -> PathBuf {
    if let Ok(env_dir) = std::env::var("CAPRI_ASSETS_DIR") {
        let p = PathBuf::from(env_dir);
        if p.exists() {
            return p;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p1 = dir.join("assets");
            if p1.exists() {
                return p1;
            }
            if let Some(parent) = dir.parent() {
                let p2 = parent.join("assets");
                if p2.exists() {
                    return p2;
                }
            }
        }
    }
    let repo_assets = PathBuf::from(r"D:\code\CapriCore\assets");
    if repo_assets.exists() {
        return repo_assets;
    }
    PathBuf::from("assets")
}

async fn resolve_brain_endpoint() -> (String, String) {
    let preferred = std::env::var("CAPRI_BRAIN_URL")
        .unwrap_or_else(|_| "http://100.109.116.120:18789".to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1600))
        .build()
        .ok();

    if let Some(cli) = &client {
        let probe = format!("{}/health", preferred.trim_end_matches('/'));
        if let Ok(resp) = cli.get(&probe).send().await {
            if resp.status().is_success() {
                return (preferred.trim_end_matches('/').to_string(), "blackarch-remote".to_string());
            }
        }
    }

    // Check if local fallback daemon already running on 127.0.0.1:18789
    if let Some(cli) = &client {
        if let Ok(resp) = cli.get("http://127.0.0.1:18789/health").send().await {
            if resp.status().is_success() {
                return ("http://127.0.0.1:18789".to_string(), "windows-local".to_string());
            }
        }
    }

    // Spawn local sibling capri-braind.exe as fallback if available
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let braind_exe = dir.join("capri-braind.exe");
            if braind_exe.exists() {
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    let _ = std::process::Command::new(&braind_exe)
                        .env("CAPRI_BIND", "127.0.0.1:18789")
                        .creation_flags(0x0800_0000)
                        .spawn();
                }
                tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                return ("http://127.0.0.1:18789".to_string(), "windows-local".to_string());
            }
        }
    }

    (preferred.trim_end_matches('/').to_string(), "blackarch-offline-retry".to_string())
}

async fn run_static_asset_server(std_listener: std::net::TcpListener, assets_dir: PathBuf) {
    let Ok(listener) = TcpListener::from_std(std_listener) else {
        return;
    };
    let root = Arc::new(assets_dir);

    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            continue;
        };
        let root = Arc::clone(&root);
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            let Ok(n) = stream.read(&mut buf).await else {
                return;
            };
            let req = String::from_utf8_lossy(&buf[..n]);
            let path_part = req
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .unwrap_or("/")
                .split('?')
                .next()
                .unwrap_or("/");
            let rel = path_part.trim_start_matches('/').replace('\\', "/");
            if rel.contains("..") || rel.is_empty() {
                let _ = stream
                    .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                    .await;
                return;
            }
            let file_path = root.join(&rel);
            match tokio::fs::read(&file_path).await {
                Ok(bytes) => {
                    let ctype = if rel.ends_with(".png") {
                        "image/png"
                    } else if rel.ends_with(".json") {
                        "application/json"
                    } else if rel.ends_with(".mp3") {
                        "audio/mpeg"
                    } else if rel.ends_with(".webp") {
                        "image/webp"
                    } else {
                        "application/octet-stream"
                    };
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: max-age=3600\r\n\r\n",
                        ctype,
                        bytes.len()
                    );
                    let _ = stream.write_all(header.as_bytes()).await;
                    let _ = stream.write_all(&bytes).await;
                }
                Err(_) => {
                    let _ = stream
                        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                        .await;
                }
            }
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let assets_dir = resolve_assets_dir();
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback asset server");
    std_listener
        .set_nonblocking(true)
        .expect("set asset server nonblocking");
    let asset_port = std_listener.local_addr().unwrap().port();
    let asset_base_url = format!("http://127.0.0.1:{}", asset_port);

    let (brain_url, brain_mode) = tauri::async_runtime::block_on(resolve_brain_endpoint());

    let hit_rects = Arc::new(Mutex::new(Vec::<HitRect>::new()));
    let click_through_locked = Arc::new(AtomicBool::new(false));
    let dragging_active = Arc::new(AtomicBool::new(false));

    let state = UiState {
        asset_base_url,
        assets_dir: assets_dir.clone(),
        brain_url,
        brain_mode,
        hit_rects: Arc::clone(&hit_rects),
        click_through_locked: Arc::clone(&click_through_locked),
        dragging_active: Arc::clone(&dragging_active),
    };

    let listener_slot = Arc::new(Mutex::new(Some(std_listener)));
    let listener_for_setup = Arc::clone(&listener_slot);
    let assets_for_setup = assets_dir;

    tauri::Builder::default()
        .manage(state)
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_config,
            update_hit_rects,
            set_dragging,
            set_click_through,
            capture_screen_b64,
            exec_desktop_action,
            auto_perch_window,
            move_to_bottom_right,
            quit_app,
        ])
        .setup(move |app| {
            use tauri::Manager;
            if let Ok(mut guard) = listener_for_setup.lock() {
                if let Some(lst) = guard.take() {
                    let dir = assets_for_setup.clone();
                    tauri::async_runtime::spawn(async move {
                        run_static_asset_server(lst, dir).await;
                    });
                }
            }
            let main_win = app.get_webview_window("main").unwrap();
            let scale = main_win.scale_factor().unwrap_or(1.0);
            let win_w = (360.0 * scale).round() as i32;
            let win_h = (420.0 * scale).round() as i32;
            let (screen_w, screen_h) = win_auto::get_primary_screen_rect();
            let _ = main_win.set_position(PhysicalPosition::new(
                (screen_w - win_w - 18).max(0),
                (screen_h - win_h - 46).max(0),
            ));

            // Background 30Hz cursor hit-test loop so transparent margins click straight through
            let rects_ref = Arc::clone(&hit_rects);
            let lock_ref = Arc::clone(&click_through_locked);
            let drag_ref = Arc::clone(&dragging_active);
            let win_clone = main_win.clone();
            std::thread::spawn(move || {
                let mut last_ignored = false;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(32));
                    if drag_ref.load(Ordering::Relaxed) {
                        continue;
                    }
                    let Some((cx, cy)) = win_auto::get_cursor_physical_pos() else {
                        continue;
                    };
                    let Ok(pos) = win_clone.outer_position() else {
                        continue;
                    };
                    let sf = win_clone.scale_factor().unwrap_or(1.0);
                    let lx = (cx - pos.x) as f64 / sf;
                    let ly = (cy - pos.y) as f64 / sf;

                    let inside = if let Ok(rects) = rects_ref.lock() {
                        rects.is_empty()
                            || rects
                                .iter()
                                .any(|r| lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h)
                    } else {
                        true
                    };

                    let should_ignore = !inside && !lock_ref.load(Ordering::Relaxed);
                    if should_ignore != last_ignored {
                        let _ = win_clone.set_ignore_cursor_events(should_ignore);
                        last_ignored = should_ignore;
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Capri-RS Tauri application");
}
