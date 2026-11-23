mod win_auto;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Emitter, PhysicalPosition, PhysicalSize, Size, State};
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
fn get_runtime_config(window: tauri::WebviewWindow, state: State<'_, UiState>) -> Value {
    let load_json = |rel: &str, fallback: Value| -> Value {
        let p = state.assets_dir.join(rel);
        std::fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(fallback)
    };
    let (screen_w, screen_h) = win_auto::get_primary_screen_rect();
    let sf = window.scale_factor().unwrap_or(1.0);

    json!({
        "brainUrl": state.brain_url,
        "brainMode": state.brain_mode,
        "assetBaseUrl": state.asset_base_url,
        "assetsDir": state.assets_dir.display().to_string(),
        "screenWidth": (screen_w as f64) / sf,
        "screenHeight": ((screen_h - 1).max(600) as f64) / sf,
        "scaleFactor": sf,
        "manifest": load_json("capri/sprites/v1/runtime-sprite-set.json", json!({ "sprites": [] })),
        "intro": load_json("capri/intro-v1/runtime-intro.json", json!({ "frames": [] })),
        "poses": load_json("capri/sprites/poses-v2/runtime-poses.json", json!({ "sprites": [] })),
        "music": load_json("default/capri-music-v1/runtime-music.json", json!({})),
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
    let _ = window.set_ignore_cursor_events(!active);
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
    let sf = window.scale_factor().unwrap_or(1.0);
    let actor_size = 320.0;
    let (screen_w, screen_h) = win_auto::get_primary_screen_rect();
    let logical_w = (screen_w as f64) / sf;
    let logical_h = ((screen_h - 1).max(600) as f64) / sf;

    let fg_rect = json!({
        "x": (target.x as f64) / sf,
        "y": (target.y as f64) / sf,
        "w": (target.width as f64) / sf,
        "h": (target.height as f64) / sf,
    });
    let target_x = ((target.x as f64) / sf + (target.width as f64) / sf - actor_size - 16.0)
        .clamp(0.0, (logical_w - actor_size).max(0.0));
    let target_y = ((target.y as f64) / sf - actor_size * 0.56)
        .clamp(0.0, (logical_h - actor_size).max(0.0));

    Ok(json!({
        "ok": true,
        "spot": "perch",
        "targetTitle": target.title,
        "fgRect": fg_rect,
        "x": target_x.round(),
        "y": target_y.round()
    }))
}

#[tauri::command]
fn move_to_bottom_right(window: tauri::WebviewWindow) -> Result<Value, String> {
    let sf = window.scale_factor().unwrap_or(1.0);
    let actor_size = 320.0;
    let (screen_w, screen_h) = win_auto::get_primary_screen_rect();
    let logical_w = (screen_w as f64) / sf;
    let logical_h = ((screen_h - 1).max(600) as f64) / sf;
    let x = (logical_w - actor_size - 18.0).max(0.0).round();
    let y = (logical_h - actor_size - 48.0).max(0.0).round();
    Ok(json!({ "ok": true, "spot": "bottom_right", "x": x, "y": y }))
}

#[tauri::command]
fn move_to_spot(window: tauri::WebviewWindow, spot: String) -> Result<Value, String> {
    let sf = window.scale_factor().unwrap_or(1.0);
    let actor_size = 320.0;
    let (screen_w, screen_h) = win_auto::get_primary_screen_rect();
    let logical_w = (screen_w as f64) / sf;
    let logical_h = ((screen_h - 1).max(600) as f64) / sf;

    match spot.as_str() {
        "perch" => auto_perch_window(window),
        "ceiling" => Ok(json!({
            "ok": true,
            "spot": "ceiling",
            "x": ((logical_w - actor_size) * 0.5).max(0.0).round(),
            "y": -18.0
        })),
        "dock_left" => Ok(json!({
            "ok": true,
            "spot": "dock_left",
            "x": -48.0,
            "y": ((logical_h - actor_size) * 0.48).max(0.0).round()
        })),
        "dock_right" => Ok(json!({
            "ok": true,
            "spot": "dock_right",
            "x": (logical_w - actor_size + 48.0).round(),
            "y": ((logical_h - actor_size) * 0.48).max(0.0).round()
        })),
        "bottom_left" => Ok(json!({
            "ok": true,
            "spot": "bottom_left",
            "x": 20.0,
            "y": (logical_h - actor_size - 48.0).max(0.0).round()
        })),
        "sit_floor" => Ok(json!({
            "ok": true,
            "spot": "sit_floor",
            "x": (logical_w - actor_size - 190.0).max(24.0).round(),
            "y": (logical_h - actor_size - 48.0).max(0.0).round()
        })),
        _ => move_to_bottom_right(window),
    }
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
            let first_line = req.lines().next().unwrap_or("");
            let method = first_line.split_whitespace().next().unwrap_or("GET");
            if method == "OPTIONS" {
                let _ = stream
                    .write_all(b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\n\r\n")
                    .await;
                return;
            }
            let path_part = first_line
                .split_whitespace()
                .nth(1)
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
                    } else if rel.ends_with(".svg") {
                        "image/svg+xml"
                    } else if rel.ends_with(".mjs") || rel.ends_with(".js") {
                        "text/javascript; charset=utf-8"
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
            move_to_spot,
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
            let (screen_w, screen_h) = win_auto::get_primary_screen_rect();
            let stage_w = (screen_w as u32).max(800);
            let stage_h = ((screen_h - 1).max(600)) as u32;
            let _ = main_win.set_position(PhysicalPosition::new(0, 0));
            let _ = main_win.set_size(Size::Physical(PhysicalSize::new(stage_w, stage_h)));
            let _ = main_win.set_ignore_cursor_events(true);

            // Background 30Hz cursor hit-test + hotkey + human laptop telemetry loop
            let rects_ref = Arc::clone(&hit_rects);
            let lock_ref = Arc::clone(&click_through_locked);
            let drag_ref = Arc::clone(&dragging_active);
            let win_clone = main_win.clone();
            std::thread::spawn(move || {
                let mut last_ignored = true;
                let mut last_cx = f64::NAN;
                let mut last_cy = f64::NAN;
                let mut tick_count: u64 = 0;
                let mut last_hotkey_down = false;
                let mut last_hotkey_at = std::time::Instant::now()
                    .checked_sub(std::time::Duration::from_secs(5))
                    .unwrap_or_else(std::time::Instant::now);

                loop {
                    std::thread::sleep(std::time::Duration::from_millis(32));
                    tick_count = tick_count.wrapping_add(1);

                    let sf = win_clone.scale_factor().unwrap_or(1.0);
                    let logical_w = (screen_w as f64) / sf;
                    let logical_h = ((screen_h - 1).max(600) as f64) / sf;

                    if let Some((cx, cy)) = win_auto::get_cursor_physical_pos() {
                        let lx = if let Ok(pos) = win_clone.outer_position() {
                            (cx - pos.x) as f64 / sf
                        } else {
                            (cx as f64) / sf
                        };
                        let ly = if let Ok(pos) = win_clone.outer_position() {
                            (cy - pos.y) as f64 / sf
                        } else {
                            (cy as f64) / sf
                        };

                        let moved = last_cx.is_nan()
                            || (lx - last_cx).abs() >= 2.0
                            || (ly - last_cy).abs() >= 2.0;
                        if moved || tick_count % 4 == 0 {
                            let _ = win_clone.emit(
                                "capri-cursor",
                                json!({
                                    "x": lx,
                                    "y": ly,
                                    "screenW": logical_w,
                                    "screenH": logical_h,
                                }),
                            );
                            last_cx = lx;
                            last_cy = ly;
                        }

                        if !drag_ref.load(Ordering::Relaxed) {
                            let inside = if let Ok(rects) = rects_ref.lock() {
                                !rects.is_empty()
                                    && rects
                                        .iter()
                                        .any(|r| lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h)
                            } else {
                                false
                            };

                            let should_ignore = !inside && !lock_ref.load(Ordering::Relaxed);
                            if should_ignore != last_ignored {
                                let _ = win_clone.set_ignore_cursor_events(should_ignore);
                                last_ignored = should_ignore;
                            }
                        }

                        let hotkey_down = win_auto::is_summon_hotkey_pressed();
                        if hotkey_down
                            && !last_hotkey_down
                            && last_hotkey_at.elapsed() >= std::time::Duration::from_millis(700)
                        {
                            last_hotkey_at = std::time::Instant::now();
                            let _ = win_clone.emit(
                                "capri-summon",
                                json!({
                                    "source": "hotkey",
                                    "cursorX": lx,
                                    "cursorY": ly,
                                }),
                            );
                        }
                        last_hotkey_down = hotkey_down;
                    }

                    if tick_count % 48 == 0 {
                        let snap = win_auto::sample_foreground_and_system();
                        let _ = win_clone.emit(
                            "capri-activity",
                            json!({
                                "fgTitle": snap.fg_title,
                                "fgExe": snap.fg_exe,
                                "fgRect": {
                                    "x": (snap.fg_x as f64) / sf,
                                    "y": (snap.fg_y as f64) / sf,
                                    "w": (snap.fg_w as f64) / sf,
                                    "h": (snap.fg_h as f64) / sf,
                                },
                                "fgFullscreen": snap.fg_fullscreen,
                                "activityMode": snap.activity_mode,
                                "idleMs": snap.idle_ms,
                                "batteryPct": snap.battery_pct,
                                "onAc": snap.on_ac,
                            }),
                        );
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Capri-RS Tauri application");
}
