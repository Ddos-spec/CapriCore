use anyhow::{anyhow, Result};
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Cursor;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowRectInfo {
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForegroundSnapshot {
    pub fg_title: String,
    pub fg_exe: String,
    pub fg_x: i32,
    pub fg_y: i32,
    pub fg_w: i32,
    pub fg_h: i32,
    pub fg_fullscreen: bool,
    pub activity_mode: String,
    pub idle_ms: u32,
    pub battery_pct: u8,
    pub on_ac: bool,
}

fn classify_activity(exe: &str, title: &str, fg_fullscreen: bool) -> String {
    let e = exe.to_ascii_lowercase();
    let t = title.to_ascii_lowercase();
    if [
        "code.exe",
        "cursor.exe",
        "windowsterminal.exe",
        "powershell.exe",
        "pwsh.exe",
        "cmd.exe",
        "idea64.exe",
        "webstorm64.exe",
        "pycharm64.exe",
        "zed.exe",
        "nvim.exe",
        "sublime_text.exe",
        "githubdesktop.exe",
    ]
    .iter()
    .any(|k| e == *k)
        || e.contains("antigravity")
        || t.contains("visual studio code")
        || t.contains("antigravity")
        || t.contains("powershell")
        || t.contains("terminal")
    {
        return "coding".to_string();
    }

    if ["spotify.exe", "foobar2000.exe", "aimp.exe"]
        .iter()
        .any(|k| e == *k)
        || (e == "vlc.exe" && !fg_fullscreen)
        || t.contains("spotify")
        || t.contains("youtube music")
        || t.contains("soundcloud")
        || t.contains("lo-fi")
        || t.contains("lofi")
        || t.contains("official music video")
        || t.contains("lyrics")
        || t.contains("playlist")
    {
        return "music".to_string();
    }

    if fg_fullscreen
        || ["steam.exe", "valorant.exe", "genshinimpact.exe", "cyberpunk2077.exe", "robloxplayerbeta.exe", "minecraft.exe", "mpv.exe", "obs64.exe"]
            .iter()
            .any(|k| e == *k)
        || t.contains("youtube")
        || t.contains("netflix")
        || t.contains("twitch")
        || t.contains("disney+")
        || t.contains("prime video")
        || t.contains("bilibili")
    {
        return "video_game".to_string();
    }

    if [
        "chrome.exe",
        "msedge.exe",
        "firefox.exe",
        "brave.exe",
        "opera.exe",
        "discord.exe",
        "whatsapp.exe",
        "telegram.exe",
        "notion.exe",
        "obsidian.exe",
        "acrobat.exe",
        "sumatrapdf.exe",
    ]
    .iter()
    .any(|k| e == *k)
    {
        return "browsing".to_string();
    }

    "desktop".to_string()
}

#[cfg(target_os = "windows")]
pub fn sample_foreground_and_system() -> ForegroundSnapshot {
    use windows_sys::Win32::Foundation::{CloseHandle, RECT};
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    };

    let (screen_w, screen_h) = get_primary_screen_rect();
    let mut fg_title = String::new();
    let mut fg_exe = String::new();
    let mut fg_x = 0;
    let mut fg_y = 0;
    let mut fg_w = 0;
    let mut fg_h = 0;

    unsafe {
        let hwnd = GetForegroundWindow();
        if !hwnd.is_null() {
            let mut buf = [0u16; 256];
            let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if len > 0 {
                fg_title = String::from_utf16_lossy(&buf[..len as usize]);
            }
            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut rect) != 0 {
                fg_x = rect.left;
                fg_y = rect.top;
                fg_w = (rect.right - rect.left).max(0);
                fg_h = (rect.bottom - rect.top).max(0);
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid != 0 {
                let h_proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if !h_proc.is_null() {
                    let mut pbuf = [0u16; 512];
                    let mut psize = pbuf.len() as u32;
                    if QueryFullProcessImageNameW(h_proc, 0, pbuf.as_mut_ptr(), &mut psize) != 0 {
                        let full = String::from_utf16_lossy(&pbuf[..psize as usize]);
                        fg_exe = full
                            .rsplit(['\\', '/'])
                            .next()
                            .unwrap_or("")
                            .to_ascii_lowercase();
                    }
                    CloseHandle(h_proc);
                }
            }
        }

        let mut lii: LASTINPUTINFO = std::mem::zeroed();
        lii.cbSize = std::mem::size_of::<LASTINPUTINFO>() as u32;
        let idle_ms = if GetLastInputInfo(&mut lii) != 0 {
            GetTickCount().wrapping_sub(lii.dwTime)
        } else {
            0
        };

        let mut sps: SYSTEM_POWER_STATUS = std::mem::zeroed();
        let (battery_pct, on_ac) = if GetSystemPowerStatus(&mut sps) != 0 {
            (sps.BatteryLifePercent, sps.ACLineStatus != 0)
        } else {
            (255, true)
        };

        let fg_fullscreen = fg_w >= screen_w - 8
            && fg_h >= screen_h - 8
            && fg_exe != "explorer.exe"
            && fg_exe != "capri-ui.exe"
            && fg_title != "Program Manager"
            && !fg_title.is_empty();

        let activity_mode = classify_activity(&fg_exe, &fg_title, fg_fullscreen);

        ForegroundSnapshot {
            fg_title,
            fg_exe,
            fg_x,
            fg_y,
            fg_w,
            fg_h,
            fg_fullscreen,
            activity_mode,
            idle_ms,
            battery_pct,
            on_ac,
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn sample_foreground_and_system() -> ForegroundSnapshot {
    ForegroundSnapshot {
        fg_title: String::new(),
        fg_exe: String::new(),
        fg_x: 0,
        fg_y: 0,
        fg_w: 0,
        fg_h: 0,
        fg_fullscreen: false,
        activity_mode: "desktop".to_string(),
        idle_ms: 0,
        battery_pct: 255,
        on_ac: true,
    }
}

#[cfg(target_os = "windows")]
pub fn is_summon_hotkey_pressed() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    unsafe {
        let ctrl = GetAsyncKeyState(0x11) < 0;
        let alt = GetAsyncKeyState(0x12) < 0;
        let shift = GetAsyncKeyState(0x10) < 0;
        let c_key = GetAsyncKeyState(0x43) < 0;
        (ctrl || alt) && shift && c_key
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_summon_hotkey_pressed() -> bool {
    false
}

/// Capture the primary monitor, downscale to max width 1280, and encode as JPEG base64 data URL.
pub fn capture_screen_data_url() -> Result<(String, u32, u32)> {
    let monitors = xcap::Monitor::all().map_err(|e| anyhow!("Monitor::all failed: {}", e))?;
    let mut selected = None;
    for m in monitors {
        if m.is_primary().unwrap_or(false) {
            selected = Some(m);
            break;
        }
        if selected.is_none() {
            selected = Some(m);
        }
    }
    let primary = selected.ok_or_else(|| anyhow!("No active monitor found"))?;

    let rgba = primary
        .capture_image()
        .map_err(|e| anyhow!("capture_image failed: {}", e))?;
    let dyn_img = image::DynamicImage::ImageRgba8(rgba);
    let w = dyn_img.width();
    let h = dyn_img.height();

    let resized = if w > 1280 {
        let new_h = ((h as f64) * (1280.0 / w as f64)).round() as u32;
        dyn_img.resize_exact(1280, new_h.max(1), FilterType::Triangle)
    } else {
        dyn_img
    };

    let out_w = resized.width();
    let out_h = resized.height();
    let rgb = resized.to_rgb8();
    let mut jpg_buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg_buf, 78);
    encoder.encode_image(&rgb)?;

    let b64 = encode_base64(&jpg_buf);
    Ok((format!("data:image/jpeg;base64,{}", b64), out_w, out_h))
}

#[cfg(target_os = "windows")]
pub fn list_top_windows() -> Vec<WindowRectInfo> {
    use uiautomation::controls::ControlType;
    use uiautomation::UIAutomation;

    let mut out = Vec::new();
    let Ok(automation) = UIAutomation::new() else {
        return out;
    };
    let Ok(root) = automation.get_root_element() else {
        return out;
    };
    let matcher = automation
        .create_matcher()
        .from(root)
        .depth(1)
        .timeout(250);
    let Ok(children) = matcher.find_all() else {
        return out;
    };

    for el in children {
        let Ok(ct) = el.get_control_type() else {
            continue;
        };
        if ct != ControlType::Window {
            continue;
        }
        let title = el.get_name().unwrap_or_default();
        if title.is_empty()
            || title == "Capri"
            || title == "Program Manager"
            || title.contains("Windows Input Experience")
        {
            continue;
        }
        let Ok(rect) = el.get_bounding_rectangle() else {
            continue;
        };
        let w = rect.get_width();
        let h = rect.get_height();
        if w < 180 || h < 120 || rect.get_left() < -5000 {
            continue;
        }
        out.push(WindowRectInfo {
            title,
            x: rect.get_left(),
            y: rect.get_top(),
            width: w,
            height: h,
        });
    }
    out
}

#[cfg(not(target_os = "windows"))]
pub fn list_top_windows() -> Vec<WindowRectInfo> {
    Vec::new()
}

#[cfg(target_os = "windows")]
pub fn get_cursor_physical_pos() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut pt) != 0 {
            return Some((pt.x, pt.y));
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
pub fn get_cursor_physical_pos() -> Option<(i32, i32)> {
    None
}

#[cfg(target_os = "windows")]
pub fn get_primary_screen_rect() -> (i32, i32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN).max(800);
        let h = GetSystemMetrics(SM_CYSCREEN).max(600);
        (w, h)
    }
}

#[cfg(not(target_os = "windows"))]
pub fn get_primary_screen_rect() -> (i32, i32) {
    (1920, 1080)
}

#[cfg(target_os = "windows")]
pub fn execute_desktop_action(args: &Value) -> Result<Value> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN,
        MOUSEEVENTF_RIGHTUP, MOUSEINPUT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SetCursorPos;

    let action = args
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("status");

    match action {
        "screenshot" | "inspect_screen" => {
            let (data_url, w, h) = capture_screen_data_url()?;
            let windows = list_top_windows();
            Ok(json!({
                "ok": true,
                "action": action,
                "width": w,
                "height": h,
                "dataUrl": data_url,
                "windows": windows,
            }))
        }
        "click" | "double_click" | "move" => {
            let x = args.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let y = args.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            unsafe {
                SetCursorPos(x, y);
                if action != "move" {
                    let button = args.get("button").and_then(|v| v.as_str()).unwrap_or("left");
                    let (down_flag, up_flag) = if button == "right" {
                        (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
                    } else {
                        (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
                    };
                    let clicks = if action == "double_click" { 2 } else { 1 };
                    for _ in 0..clicks {
                        let inputs = [
                            INPUT {
                                r#type: INPUT_MOUSE,
                                Anonymous: INPUT_0 {
                                    mi: MOUSEINPUT {
                                        dx: 0,
                                        dy: 0,
                                        mouseData: 0,
                                        dwFlags: down_flag,
                                        time: 0,
                                        dwExtraInfo: 0,
                                    },
                                },
                            },
                            INPUT {
                                r#type: INPUT_MOUSE,
                                Anonymous: INPUT_0 {
                                    mi: MOUSEINPUT {
                                        dx: 0,
                                        dy: 0,
                                        mouseData: 0,
                                        dwFlags: up_flag,
                                        time: 0,
                                        dwExtraInfo: 0,
                                    },
                                },
                            },
                        ];
                        SendInput(2, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
                        std::thread::sleep(std::time::Duration::from_millis(45));
                    }
                }
            }
            Ok(json!({ "ok": true, "action": action, "x": x, "y": y }))
        }
        "type" | "type_text" => {
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let press_enter = args
                .get("press_enter")
                .or_else(|| args.get("enter"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            for ch in text.chars() {
                let mut utf16 = [0u16; 2];
                for &mut unit in ch.encode_utf16(&mut utf16) {
                    let inputs = [
                        INPUT {
                            r#type: INPUT_KEYBOARD,
                            Anonymous: INPUT_0 {
                                ki: KEYBDINPUT {
                                    wVk: 0,
                                    wScan: unit,
                                    dwFlags: KEYEVENTF_UNICODE,
                                    time: 0,
                                    dwExtraInfo: 0,
                                },
                            },
                        },
                        INPUT {
                            r#type: INPUT_KEYBOARD,
                            Anonymous: INPUT_0 {
                                ki: KEYBDINPUT {
                                    wVk: 0,
                                    wScan: unit,
                                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                                    time: 0,
                                    dwExtraInfo: 0,
                                },
                            },
                        },
                    ];
                    unsafe {
                        SendInput(2, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
                    }
                }
            }
            if press_enter {
                send_vk_combo(&["enter"]);
            }
            Ok(json!({ "ok": true, "action": "type", "chars": text.chars().count() }))
        }
        "key" | "hotkey" => {
            let keys: Vec<String> = if let Some(arr) = args.get("keys").and_then(|v| v.as_array()) {
                arr.iter()
                    .filter_map(|v| v.as_str().map(ToString::to_string))
                    .collect()
            } else if let Some(k) = args.get("key").and_then(|v| v.as_str()) {
                k.split('+').map(|s| s.trim().to_string()).collect()
            } else {
                Vec::new()
            };
            let refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
            send_vk_combo(&refs);
            Ok(json!({ "ok": true, "action": "hotkey", "keys": keys }))
        }
        "shell" | "run_command" => {
            use std::os::windows::process::CommandExt;
            let command = args
                .get("command")
                .or_else(|| args.get("cmd"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let cwd = args.get("cwd").and_then(|v| v.as_str());
            if command.is_empty() {
                return Err(anyhow!("empty command"));
            }
            let mut cmd = std::process::Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", command])
                .creation_flags(0x0800_0000);
            if let Some(dir) = cwd {
                cmd.current_dir(dir);
            }
            let out = cmd.output()?;
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            Ok(json!({
                "ok": out.status.success(),
                "exitCode": out.status.code(),
                "stdout": stdout.chars().take(4000).collect::<String>(),
                "stderr": stderr.chars().take(2000).collect::<String>(),
            }))
        }
        "open_app" | "open_url" => {
            use std::os::windows::process::CommandExt;
            let target = args
                .get("target")
                .or_else(|| args.get("app"))
                .or_else(|| args.get("url"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if target.is_empty() {
                return Err(anyhow!("missing open target"));
            }
            std::process::Command::new("cmd.exe")
                .args(["/C", "start", "", target])
                .creation_flags(0x0800_0000)
                .spawn()?;
            Ok(json!({ "ok": true, "opened": target }))
        }
        "read_file" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let content = std::fs::read_to_string(path)?;
            Ok(json!({
                "ok": true,
                "path": path,
                "content": content.chars().take(8000).collect::<String>()
            }))
        }
        "write_file" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(p) = std::path::Path::new(path).parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::write(path, content)?;
            Ok(json!({ "ok": true, "path": path, "bytes": content.len() }))
        }
        "list_dir" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(r"D:\code");
            let mut entries = Vec::new();
            for ent in std::fs::read_dir(path)? {
                if let Ok(e) = ent {
                    let name = e.file_name().to_string_lossy().to_string();
                    let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    entries.push(json!({ "name": name, "dir": is_dir }));
                    if entries.len() >= 120 {
                        break;
                    }
                }
            }
            Ok(json!({ "ok": true, "path": path, "entries": entries }))
        }
        "list_windows" => Ok(json!({ "ok": true, "windows": list_top_windows() })),
        other => Err(anyhow!("Unsupported desktop action: {}", other)),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn execute_desktop_action(_args: &Value) -> Result<Value> {
    Ok(json!({ "ok": false, "error": "Windows desktop actions only available on Windows" }))
}

#[cfg(target_os = "windows")]
fn send_vk_combo(keys: &[&str]) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };
    let mut vks = Vec::new();
    for k in keys {
        if let Some(vk) = map_vk(k) {
            vks.push(vk);
        }
    }
    if vks.is_empty() {
        return;
    }
    let mut inputs = Vec::with_capacity(vks.len() * 2);
    for &vk in &vks {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
    }
    for &vk in vks.iter().rev() {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
    }
    unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
}

#[cfg(target_os = "windows")]
fn map_vk(name: &str) -> Option<u16> {
    let n = name.trim().to_ascii_lowercase();
    let vk = match n.as_str() {
        "ctrl" | "control" => 0x11,
        "alt" | "menu" => 0x12,
        "shift" => 0x10,
        "win" | "lwin" | "super" => 0x5B,
        "enter" | "return" => 0x0D,
        "tab" => 0x09,
        "esc" | "escape" => 0x1B,
        "space" => 0x20,
        "backspace" => 0x08,
        "delete" | "del" => 0x2E,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        "home" => 0x24,
        "end" => 0x23,
        "pgup" | "pageup" => 0x21,
        "pgdn" | "pagedown" => 0x22,
        s if s.starts_with('f') && s.len() <= 3 => {
            let num: u16 = s[1..].parse().ok()?;
            if (1..=12).contains(&num) {
                0x6F + num
            } else {
                return None;
            }
        }
        s if s.len() == 1 => {
            let b = s.as_bytes()[0].to_ascii_uppercase();
            if b.is_ascii_alphanumeric() {
                b as u16
            } else {
                return None;
            }
        }
        _ => return None,
    };
    Some(vk)
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((input.len() + 2) / 3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 0x3F) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 0x3F) as usize] as char } else { '=' });
    }
    out
}

#[allow(dead_code)]
fn _keep_cursor(_: Cursor<Vec<u8>>) {}
