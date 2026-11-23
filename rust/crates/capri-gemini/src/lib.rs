use anyhow::{anyhow, Context, Result};
use capri_core::InlineImage;
use regex::Regex;
use reqwest::header::{COOKIE, CONTENT_TYPE, ORIGIN, REFERER, USER_AGENT};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};
use uuid::Uuid;

const USER_AGENT_STR: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const FLASH_JSPB_HEADER: &str = r#"[1,null,null,null,"9ec249fc9ad08861",null,null,null,[4]]"#;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CookieBundle {
    pub psid: String,
    pub psidts: String,
    #[serde(default)]
    pub cookie_header: String,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CookieStatus {
    pub ok: bool,
    pub wiz_ok: bool,
    pub rotated: bool,
    pub psid_present: bool,
    pub psidts_present: bool,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct WizTokens {
    pub at: String,
    pub bl: String,
    pub fsid: String,
}

impl WizTokens {
    pub fn is_valid(&self) -> bool {
        !self.at.is_empty() && !self.bl.is_empty()
    }
}

struct InnerState {
    bundle: CookieBundle,
    wiz: WizTokens,
}

pub struct GeminiClient {
    http: reqwest::Client,
    state: Arc<RwLock<InnerState>>,
    cookies_path: PathBuf,
    fallback_url: Option<String>,
    reqid_seq: AtomicU64,
}

impl GeminiClient {
    pub fn new(cookies_path: PathBuf, fallback_url: Option<String>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT_STR)
            .timeout(std::time::Duration::from_secs(90))
            .build()?;

        let loaded = if cookies_path.exists() {
            match std::fs::read_to_string(&cookies_path) {
                Ok(raw) => serde_json::from_str::<CookieBundle>(&raw).unwrap_or_default(),
                Err(_) => CookieBundle::default(),
            }
        } else {
            CookieBundle::default()
        };

        let client = Self {
            http,
            state: Arc::new(RwLock::new(InnerState {
                bundle: loaded,
                wiz: WizTokens::default(),
            })),
            cookies_path,
            fallback_url,
            reqid_seq: AtomicU64::new(100_000 + (now_epoch_secs() % 800_000)),
        };
        Ok(client)
    }

    pub async fn status(&self) -> (bool, bool) {
        let g = self.state.read().await;
        let has_cookies = !g.bundle.psid.is_empty() || !g.bundle.cookie_header.is_empty();
        (has_cookies, g.wiz.is_valid())
    }

    /// Ensure cached cookies immediately validate against Gemini `/app` on daemon boot.
    pub async fn warm_start(&self) {
        let has_cookies = {
            let g = self.state.read().await;
            !g.bundle.psid.is_empty() || !g.bundle.cookie_header.is_empty()
        };
        if has_cookies {
            match self.fetch_wiz_tokens().await {
                Ok(_) => info!("Gemini warm-start WIZ token sync succeeded"),
                Err(e) => warn!("Gemini warm-start WIZ fetch skipped/failed: {}", e),
            }
        }
    }

    /// Spawn background 9-minute cookie rotation timer so `__Secure-1PSIDTS` stays fresh.
    pub fn spawn_rotation_task(self: &Arc<Self>) {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(540));
            interval.tick().await; // skip immediate first tick
            loop {
                interval.tick().await;
                let has_cookies = {
                    let g = me.state.read().await;
                    !g.bundle.psid.is_empty()
                };
                if has_cookies {
                    match me.rotate_cookies().await {
                        Ok(true) => info!("Gemini background RotateCookies refreshed PSIDTS"),
                        Ok(false) => {}
                        Err(e) => warn!("Gemini background RotateCookies error: {}", e),
                    }
                }
            }
        });
    }

    pub async fn set_cookies(
        &self,
        psid: String,
        psidts: String,
        cookie_header: String,
    ) -> Result<CookieStatus> {
        let mut map = parse_cookie_map(&cookie_header);
        if !psid.trim().is_empty() {
            map.insert("__Secure-1PSID".to_string(), psid.trim().to_string());
        }
        if !psidts.trim().is_empty() {
            map.insert("__Secure-1PSIDTS".to_string(), psidts.trim().to_string());
        }
        let final_psid = map
            .get("__Secure-1PSID")
            .cloned()
            .unwrap_or_else(|| psid.trim().to_string());
        let final_psidts = map
            .get("__Secure-1PSIDTS")
            .cloned()
            .unwrap_or_else(|| psidts.trim().to_string());
        let rebuilt_header = format_cookie_map(&map);

        if final_psid.is_empty() {
            return Err(anyhow!("__Secure-1PSID is required"));
        }

        {
            let mut g = self.state.write().await;
            g.bundle = CookieBundle {
                psid: final_psid.clone(),
                psidts: final_psidts.clone(),
                cookie_header: rebuilt_header,
                updated_at: now_epoch_secs(),
            };
            g.wiz = WizTokens::default();
            save_bundle_to_disk(&self.cookies_path, &g.bundle)?;
        }

        let mut rotated = false;
        let wiz_ok = match self.fetch_wiz_tokens().await {
            Ok(_) => true,
            Err(_) => {
                rotated = self.rotate_cookies().await.unwrap_or(false);
                self.fetch_wiz_tokens().await.is_ok()
            }
        };

        let g = self.state.read().await;
        Ok(CookieStatus {
            ok: !g.bundle.psid.is_empty() && wiz_ok,
            wiz_ok,
            rotated,
            psid_present: !g.bundle.psid.is_empty(),
            psidts_present: !g.bundle.psidts.is_empty(),
            message: if wiz_ok {
                "Cookies verified and WIZ tokens active".to_string()
            } else {
                "Cookies saved, but Gemini WIZ extraction failed (check Google session)".to_string()
            },
        })
    }

    pub async fn rotate_cookies(&self) -> Result<bool> {
        let cookie_str = self.effective_cookie_header().await?;
        let resp = self
            .http
            .post("https://accounts.google.com/RotateCookies")
            .header(ORIGIN, "https://accounts.google.com")
            .header(CONTENT_TYPE, "application/json")
            .header(COOKIE, &cookie_str)
            .body(r#"[000,"-0000000000000000000"]"#)
            .send()
            .await
            .context("RotateCookies request failed")?;

        let mut new_psidts: Option<String> = None;
        for val in resp.headers().get_all(reqwest::header::SET_COOKIE) {
            if let Ok(s) = val.to_str() {
                if let Some((kv, _)) = s.split_once(';') {
                    if let Some((k, v)) = kv.split_once('=') {
                        if k.trim() == "__Secure-1PSIDTS" && !v.trim().is_empty() {
                            new_psidts = Some(v.trim().to_string());
                        }
                    }
                }
            }
        }

        if let Some(ts) = new_psidts {
            let mut g = self.state.write().await;
            g.bundle.psidts = ts.clone();
            let mut map = parse_cookie_map(&g.bundle.cookie_header);
            map.insert("__Secure-1PSID".to_string(), g.bundle.psid.clone());
            map.insert("__Secure-1PSIDTS".to_string(), ts);
            g.bundle.cookie_header = format_cookie_map(&map);
            g.bundle.updated_at = now_epoch_secs();
            save_bundle_to_disk(&self.cookies_path, &g.bundle)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn fetch_wiz_tokens(&self) -> Result<WizTokens> {
        match self.fetch_wiz_tokens_once().await {
            Ok(toks) => Ok(toks),
            Err(first_err) => {
                warn!("First WIZ fetch failed ({}), attempting RotateCookies", first_err);
                let _ = self.rotate_cookies().await;
                self.fetch_wiz_tokens_once().await
            }
        }
    }

    async fn fetch_wiz_tokens_once(&self) -> Result<WizTokens> {
        let cookie_str = self.effective_cookie_header().await?;
        let resp = self
            .http
            .get("https://gemini.google.com/app")
            .header(COOKIE, &cookie_str)
            .header(USER_AGENT, USER_AGENT_STR)
            .send()
            .await
            .context("GET gemini.google.com/app failed")?;

        let status = resp.status();
        let html = resp.text().await?;
        if !status.is_success() {
            return Err(anyhow!("gemini.google.com/app returned status {}", status));
        }

        let re_at = Regex::new(r#""SNlM0e":"([^"]+)""#)?;
        let re_bl = Regex::new(r#""cfb2h":"([^"]+)""#)?;
        let re_fsid = Regex::new(r#""FdrFJe":"([^"]+)""#)?;

        let at = re_at
            .captures(&html)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .ok_or_else(|| anyhow!("SNlM0e token missing in Gemini HTML (cookies expired or login required)"))?;
        let bl = re_bl
            .captures(&html)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| "boq_assistant-bard-web-server_20250501.00_p0".to_string());
        let fsid = re_fsid
            .captures(&html)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let toks = WizTokens { at, bl, fsid };
        let mut g = self.state.write().await;
        g.wiz = toks.clone();
        Ok(toks)
    }

    pub async fn upload_image(&self, img: &InlineImage) -> Result<String> {
        let cookie_str = self.effective_cookie_header().await?;
        let part = Part::bytes(img.bytes.clone())
            .file_name(img.filename.clone())
            .mime_str(&img.mime)?;
        let form = Form::new().part("file", part);

        let resp = self
            .http
            .post("https://content-push.googleapis.com/upload")
            .header("X-Tenant-Id", "bard-storage")
            .header("Push-ID", "feeds/mcudyrk2a4khkz")
            .header(ORIGIN, "https://gemini.google.com")
            .header(REFERER, "https://gemini.google.com/")
            .header(COOKIE, &cookie_str)
            .multipart(form)
            .send()
            .await
            .context("content-push upload request failed")?;

        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(anyhow!("content-push returned {}: {}", status, body));
        }
        let trimmed = body.trim().to_string();
        if trimmed.is_empty() {
            return Err(anyhow!("content-push returned empty path"));
        }
        Ok(trimmed)
    }

    pub async fn generate(
        &self,
        prompt: &str,
        images: Vec<InlineImage>,
        temp_chat: bool,
    ) -> Result<String> {
        match self.generate_direct(prompt, &images, temp_chat).await {
            Ok(txt) => Ok(txt),
            Err(direct_err) => {
                if let Some(fb) = &self.fallback_url {
                    warn!("Direct Gemini generation failed ({}), trying fallback {}", direct_err, fb);
                    return self.generate_via_fallback(fb, prompt).await;
                }
                Err(direct_err)
            }
        }
    }

    async fn generate_direct(
        &self,
        prompt: &str,
        images: &[InlineImage],
        temp_chat: bool,
    ) -> Result<String> {
        let mut wiz = {
            let g = self.state.read().await;
            g.wiz.clone()
        };
        if !wiz.is_valid() {
            wiz = self.fetch_wiz_tokens().await?;
        }

        let mut req_file_entries = Vec::new();
        for img in images {
            let path = self.upload_image(img).await?;
            req_file_entries.push(json!([[path, 1], img.filename]));
        }
        let req_file_data = if req_file_entries.is_empty() {
            Value::Null
        } else {
            Value::Array(req_file_entries)
        };

        match self
            .stream_generate_call(&wiz, prompt, &req_file_data, temp_chat)
            .await
        {
            Ok(text) => Ok(text),
            Err(first_err) => {
                warn!("StreamGenerate attempt 1 failed ({}), refreshing WIZ tokens", first_err);
                let fresh_wiz = self.fetch_wiz_tokens().await?;
                self.stream_generate_call(&fresh_wiz, prompt, &req_file_data, temp_chat)
                    .await
            }
        }
    }

    async fn stream_generate_call(
        &self,
        wiz: &WizTokens,
        prompt: &str,
        req_file_data: &Value,
        temp_chat: bool,
    ) -> Result<String> {
        let cookie_str = self.effective_cookie_header().await?;
        let reqid = 100_000 + (self.reqid_seq.fetch_add(100_000, Ordering::Relaxed) % 899_999);

        let mut url = format!(
            "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl={}&hl=id&_reqid={}&rt=c",
            url_encode(&wiz.bl),
            reqid
        );
        if !wiz.fsid.is_empty() {
            url.push_str(&format!("&f.sid={}", url_encode(&wiz.fsid)));
        }

        let mut inner: Vec<Value> = vec![Value::Null; 81];
        inner[0] = json!([prompt, 0, Value::Null, req_file_data, Value::Null, Value::Null, 0]);
        inner[1] = json!(["id-ID"]);
        inner[2] = json!(["", "", "", Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, ""]);
        inner[6] = json!([1]);
        inner[7] = json!(1);
        inner[10] = json!(1);
        inner[11] = json!(0);
        inner[17] = json!([[0]]);
        inner[18] = json!(0);
        inner[27] = json!(1);
        inner[30] = json!([4]);
        inner[41] = json!([1]);
        if temp_chat {
            inner[45] = json!(1);
        }
        inner[53] = json!(0);
        inner[59] = json!(Uuid::new_v4().to_string().to_uppercase());
        inner[61] = json!([]);
        inner[68] = json!(1);
        inner[79] = json!(1);
        inner[80] = json!(1);

        let outer = json!([Value::Null, serde_json::to_string(&inner)?]);
        let f_req = serde_json::to_string(&outer)?;

        let resp = self
            .http
            .post(&url)
            .header(COOKIE, &cookie_str)
            .header(ORIGIN, "https://gemini.google.com")
            .header(REFERER, "https://gemini.google.com/")
            .header("X-Same-Domain", "1")
            .header("x-goog-ext-525001261-jspb", FLASH_JSPB_HEADER)
            .form(&[("f.req", f_req.as_str()), ("at", wiz.at.as_str())])
            .send()
            .await
            .context("StreamGenerate HTTP call failed")?;

        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(anyhow!("StreamGenerate status {}: {}", status, body.chars().take(300).collect::<String>()));
        }

        let (text, conv_id) = parse_stream_generate_response(&body)?;
        if temp_chat {
            if let Some(cid) = conv_id {
                let clone_http = self.http.clone();
                let clone_cookie = cookie_str.clone();
                let clone_wiz = wiz.clone();
                let next_id = self.reqid_seq.fetch_add(100_000, Ordering::Relaxed);
                tokio::spawn(async move {
                    let _ = delete_temp_conversation(&clone_http, &clone_cookie, &clone_wiz, &cid, next_id).await;
                });
            }
        }
        Ok(text)
    }

    async fn generate_via_fallback(&self, base_url: &str, prompt: &str) -> Result<String> {
        let url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
        let payload = json!({
            "model": "gemini-2.5-flash",
            "stream": false,
            "messages": [{"role": "user", "content": prompt}]
        });
        let resp = self.http.post(&url).json(&payload).send().await?;
        let val: Value = resp.json().await?;
        let text = val["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| anyhow!("Fallback bridge returned unexpected payload: {}", val))?;
        Ok(text.to_string())
    }

    async fn effective_cookie_header(&self) -> Result<String> {
        let g = self.state.read().await;
        if !g.bundle.cookie_header.is_empty() {
            return Ok(g.bundle.cookie_header.clone());
        }
        if g.bundle.psid.is_empty() {
            return Err(anyhow!("No Google session cookies loaded. POST to /api/cookies first."));
        }
        if g.bundle.psidts.is_empty() {
            Ok(format!("__Secure-1PSID={}", g.bundle.psid))
        } else {
            Ok(format!(
                "__Secure-1PSID={}; __Secure-1PSIDTS={}",
                g.bundle.psid, g.bundle.psidts
            ))
        }
    }
}

async fn delete_temp_conversation(
    http: &reqwest::Client,
    cookie_str: &str,
    wiz: &WizTokens,
    conv_id: &str,
    seq: u64,
) -> Result<()> {
    let reqid = 100_000 + (seq % 899_999);
    let mut url = format!(
        "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=GzXR5e&bl={}&hl=id&_reqid={}&rt=c",
        url_encode(&wiz.bl),
        reqid
    );
    if !wiz.fsid.is_empty() {
        url.push_str(&format!("&f.sid={}", url_encode(&wiz.fsid)));
    }
    let inner_arg = serde_json::to_string(&json!([conv_id]))?;
    let f_req = serde_json::to_string(&json!([[["GzXR5e", inner_arg, Value::Null, "generic"]]]))?;
    let _ = http
        .post(&url)
        .header(COOKIE, cookie_str)
        .header(ORIGIN, "https://gemini.google.com")
        .header(REFERER, "https://gemini.google.com/")
        .header("X-Same-Domain", "1")
        .form(&[("f.req", f_req.as_str()), ("at", wiz.at.as_str())])
        .send()
        .await;
    Ok(())
}

/// Extract text candidate and `c_...` conversation ID from Bard/Gemini StreamGenerate chunks.
fn parse_stream_generate_response(raw: &str) -> Result<(String, Option<String>)> {
    let mut best_text = String::new();
    let mut conv_id: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('[') {
            continue;
        }
        let Ok(frames) = serde_json::from_str::<Vec<Value>>(trimmed) else {
            continue;
        };
        for frame in frames {
            let Some(arr) = frame.as_array() else {
                continue;
            };
            if arr.first().and_then(|v| v.as_str()) != Some("wrb.fr") {
                continue;
            }
            let Some(payload_str) = arr.get(2).and_then(|v| v.as_str()) else {
                continue;
            };
            let Ok(payload) = serde_json::from_str::<Value>(payload_str) else {
                continue;
            };

            if conv_id.is_none() {
                if let Some(cid) = payload.get(1).and_then(|v| v.get(0)).and_then(|v| v.as_str()) {
                    if cid.starts_with("c_") {
                        conv_id = Some(cid.to_string());
                    }
                }
            }

            if let Some(cands) = payload.get(4).and_then(|v| v.as_array()) {
                for cand in cands {
                    if let Some(parts) = cand.get(1).and_then(|v| v.as_array()) {
                        if let Some(txt) = parts.first().and_then(|v| v.as_str()) {
                            if txt.len() >= best_text.len() {
                                best_text = txt.to_string();
                            }
                        }
                    }
                }
            }
        }
    }

    if best_text.is_empty() {
        return Err(anyhow!(
            "Failed to parse StreamGenerate text (prefix: {})",
            raw.chars().take(240).collect::<String>()
        ));
    }

    Ok((best_text, conv_id))
}

fn save_bundle_to_disk(path: &PathBuf, bundle: &CookieBundle) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json_bytes = serde_json::to_vec_pretty(bundle)?;
    std::fs::write(path, json_bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn parse_cookie_map(header: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for pair in header.split(';') {
        if let Some((k, v)) = pair.split_once('=') {
            let key = k.trim();
            let val = v.trim();
            if !key.is_empty() && !val.is_empty() {
                map.insert(key.to_string(), val.to_string());
            }
        }
    }
    map
}

fn format_cookie_map(map: &BTreeMap<String, String>) -> String {
    map.iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("; ")
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
