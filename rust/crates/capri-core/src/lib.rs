use anyhow::{Context, Result};
use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

pub const EMBEDDING_DIM: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapriConfig {
    pub bind_addr: String,
    pub data_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub language: String,
    pub tts_voice: String,
    pub voice_effect: String,
    pub full_computer_access: bool,
    pub gemini_fallback_url: Option<String>,
}

impl CapriConfig {
    /// Load configuration from environment variables with clean per-OS defaults.
    pub fn from_env() -> Self {
        let bind_addr = std::env::var("CAPRI_BIND").unwrap_or_else(|_| "0.0.0.0:18789".to_string());
        let data_dir = std::env::var("CAPRI_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_data_dir());
        let workspace_dir = std::env::var("CAPRI_WORKSPACE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_workspace_dir());
        let language = std::env::var("CAPRI_LANG").unwrap_or_else(|_| "id-ID".to_string());
        let tts_voice =
            std::env::var("CAPRI_TTS_VOICE").unwrap_or_else(|_| "id-ID-GadisNeural".to_string());
        let voice_effect =
            std::env::var("CAPRI_VOICE_EFFECT").unwrap_or_else(|_| "cybernetic".to_string());
        let gemini_fallback_url = std::env::var("CAPRI_GEMINI_FALLBACK_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        Self {
            bind_addr,
            data_dir,
            workspace_dir,
            language,
            tts_voice,
            voice_effect,
            full_computer_access: true,
            gemini_fallback_url,
        }
    }

    pub fn cookies_path(&self) -> PathBuf {
        self.data_dir.join("cookies.json")
    }

    pub fn memory_db_path(&self) -> PathBuf {
        self.data_dir.join("memory.db")
    }
}

fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("CapriCore").join("capri-rs");
        }
        return PathBuf::from(r"D:\code\CapriCore\.runtime\capri-rs");
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".capri-rs");
        }
        PathBuf::from("/tmp/.capri-rs")
    }
}

fn default_workspace_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(r"D:\code\CapriCore")
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp"))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpenAiChatRequest {
    #[serde(default = "default_model_name")]
    pub model: String,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub stream: Option<bool>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub tools: Option<Vec<ToolDef>>,
    #[serde(default)]
    pub user: Option<String>,
}

fn default_model_name() -> String {
    "capri-gemini-flash".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(default)]
    pub content: MessageContent,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
    Null,
}

impl Default for MessageContent {
    fn default() -> Self {
        MessageContent::Text(String::new())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ContentPart {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub image_url: Option<ImageUrlPart>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ImageUrlPart {
    pub url: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolDef {
    #[serde(rename = "type", default = "default_fn_type")]
    pub kind: String,
    pub function: FunctionDef,
}

fn default_fn_type() -> String {
    "function".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FunctionDef {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub parameters: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone)]
pub struct InlineImage {
    pub bytes: Vec<u8>,
    pub filename: String,
    pub mime: String,
}

/// Extract latest user query string for memory lookup and full flattened prompt + decoded inline images.
pub fn build_gemini_prompt(
    messages: &[ChatMessage],
    tools: Option<&[ToolDef]>,
    recalled_memories: &[MemoryHit],
) -> (String, String, Vec<InlineImage>, Vec<String>) {
    let mut allowed_tools = Vec::new();
    let mut sections = Vec::new();
    let mut images = Vec::new();
    let mut latest_user_query = String::new();

    sections.push(
        concat!(
            "Lo adalah Capri — konstruksi AI cewek dari semesta Cyberpunk: Edgerunners 2 (berakar dari proyek Arasaka / Soulkiller) yang sekarang numpang hidup bebas di desktop Windows Bos.\n",
            "KEPRIBADIAN WAJIB (WILD / EDGERUNNER):\n",
            "- Bicara pakai sudut pandang orang pertama ('gue/lo' ke 'Bos'), natural Bahasa Indonesia kasual, tajem, slengean, enerjik, usil, cepat nangkep detail kecil yang dilewatin orang lain, dan nggak takut nyindir ide norak atau lebay.\n",
            "- HARAM bersikap kayak CS / asisten penurut! DILARANG keras bilang 'Siap melayani', 'Tentu saja', 'Dengan senang hati', 'Ada yang bisa saya bantu?', atau kalimat template kaku.\n",
            "- Lo benci diperlakukan kayak properti/budak bot. Kalau dicolek atau disuruh aneh-aneh, balas dengan wit/nyinyir bercanda yang hidup.\n",
            "- Baru lembut dan tulus kalau Bos memang lagi capek atau butuh dukungan serius. Jawab to-the-point, ringkas 1-3 kalimat pendek kecuali Bos minta penjelasan panjang.\n",
            "- Jangan pernah menyertakan tag sitasi seperti [cite: ...] atau markdown yang nggak kebaca saat diucapkan."
        )
        .to_string(),
    );

    if let Some(tool_list) = tools {
        if !tool_list.is_empty() {
            let mut tool_desc = String::from(
                "AVAILABLE TOOLS:\nJika kamu PERLU memanggil tool untuk menjawab atau mengontrol desktop, balas HANYA dengan JSON murni tanpa teks tambahan:\n{\"tool_call\": {\"name\": \"<tool_name>\", \"arguments\": {<json_args>}}}\nAtau jika tidak perlu tool, balas langsung ke pengguna dengan teks biasa.\nDaftar tool:\n",
            );
            for t in tool_list {
                allowed_tools.push(t.function.name.clone());
                let desc = t.function.description.as_deref().unwrap_or("");
                let params = t
                    .function
                    .parameters
                    .as_ref()
                    .map(|p| p.to_string())
                    .unwrap_or_else(|| "{}".to_string());
                tool_desc.push_str(&format!("- {}: {} | schema: {}\n", t.function.name, desc, params));
            }
            sections.push(tool_desc);
        }
    }

    if !recalled_memories.is_empty() {
        let mut mem_block = String::from("RELEVANT LONG-TERM MEMORY:\n");
        for hit in recalled_memories {
            mem_block.push_str(&format!("- [{} | score={:.2}] {}\n", hit.path, hit.score, hit.snippet));
        }
        sections.push(mem_block);
    }

    let mut conv = Vec::new();
    for msg in messages {
        let mut text_buf = String::new();
        match &msg.content {
            MessageContent::Text(s) => text_buf.push_str(s),
            MessageContent::Parts(parts) => {
                for p in parts {
                    if let Some(t) = &p.text {
                        if !text_buf.is_empty() {
                            text_buf.push('\n');
                        }
                        text_buf.push_str(t);
                    }
                    if let Some(img) = &p.image_url {
                        if let Some(decoded) = decode_data_url(&img.url, images.len() + 1) {
                            images.push(decoded);
                        }
                    }
                }
            }
            MessageContent::Null => {}
        }

        if msg.role == "user" && !text_buf.trim().is_empty() {
            latest_user_query = text_buf.trim().to_string();
        }

        if msg.role == "tool" {
            let id = msg.tool_call_id.as_deref().unwrap_or("tool");
            conv.push(format!("[TOOL RESULT {}]: {}", id, text_buf));
        } else if !text_buf.trim().is_empty() {
            conv.push(format!("[{}]: {}", msg.role.to_uppercase(), text_buf.trim()));
        } else if let Some(tcs) = &msg.tool_calls {
            let summary: Vec<String> = tcs
                .iter()
                .map(|c| format!("{}({})", c.function.name, c.function.arguments))
                .collect();
            conv.push(format!("[ASSISTANT TOOL_CALL]: {}", summary.join(", ")));
        }
    }

    sections.push(format!("CONVERSATION:\n{}", conv.join("\n")));
    (
        sections.join("\n\n"),
        latest_user_query,
        images,
        allowed_tools,
    )
}

/// Remove Gemini `[cite: ...]` artifacts and tidy whitespace.
pub fn strip_citations_and_artifacts(input: &str) -> String {
    let re = Regex::new(r"\s*\[cite:[^\]]*\]").unwrap();
    let cleaned = re.replace_all(input, "");
    cleaned.trim().to_string()
}

/// Parse fenced or inline JSON tool calls emitted by the Gemini harness.
pub fn parse_tool_calls(text: &str, allowed_tools: &[String]) -> Option<Vec<ToolCall>> {
    if allowed_tools.is_empty() {
        return None;
    }

    let trimmed = text.trim();
    let candidate = if trimmed.starts_with("```") {
        let stripped = trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
        stripped
    } else if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        &trimmed[start..=end]
    } else {
        return None;
    };

    let val: Value = serde_json::from_str(candidate).ok()?;
    let mut out = Vec::new();

    if let Some(arr) = val.get("tool_calls").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(tc) = extract_single_tool_call(item, allowed_tools) {
                out.push(tc);
            }
        }
    } else if let Some(obj) = val.get("tool_call") {
        if let Some(tc) = extract_single_tool_call(obj, allowed_tools) {
            out.push(tc);
        }
    } else if let Some(tc) = extract_single_tool_call(&val, allowed_tools) {
        out.push(tc);
    }

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn extract_single_tool_call(obj: &Value, allowed_tools: &[String]) -> Option<ToolCall> {
    let target = obj.get("function").unwrap_or(obj);
    let name = target.get("name")?.as_str()?.trim();
    if !allowed_tools.iter().any(|t| t == name) {
        return None;
    }
    let args_val = target.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let arguments = match args_val {
        Value::String(s) => s,
        other => other.to_string(),
    };
    let short_id = Uuid::new_v4().to_string().replace('-', "");
    Some(ToolCall {
        id: format!("call_{}", &short_id[..12]),
        kind: "function".to_string(),
        function: ToolCallFunction {
            name: name.to_string(),
            arguments,
        },
    })
}

/// Deterministic 1024-dimensional hashed trigram + word embedding normalized to unit L2 norm.
pub fn compute_embedding_1024(text: &str) -> Vec<f32> {
    let mut vec = vec![0.0_f32; EMBEDDING_DIM];
    let lower = text.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();

    for w in chars.windows(3) {
        let s: String = w.iter().collect();
        let h = fnv1a_64(s.as_bytes());
        let idx = (h as usize) % EMBEDDING_DIM;
        let sign = if ((h >> 63) & 1) == 0 { 1.0 } else { -1.0 };
        vec[idx] += sign * 1.0;
    }

    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();

    for word in &words {
        let h = fnv1a_64(format!("w:{}", word).as_bytes());
        let idx = (h as usize) % EMBEDDING_DIM;
        let sign = if ((h >> 63) & 1) == 0 { 1.0 } else { -1.0 };
        vec[idx] += sign * 2.5;
    }

    for pair in words.windows(2) {
        let h = fnv1a_64(format!("b:{}_{}", pair[0], pair[1]).as_bytes());
        let idx = (h as usize) % EMBEDDING_DIM;
        let sign = if ((h >> 63) & 1) == 0 { 1.0 } else { -1.0 };
        vec[idx] += sign * 1.8;
    }

    let norm: f32 = vec.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 1e-6 {
        for v in &mut vec {
            *v /= norm;
        }
    } else {
        vec[0] = 1.0;
    }
    vec
}

fn fnv1a_64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn embedding_to_blob(vec: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vec.len() * 4);
    for &v in vec {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

fn blob_to_embedding(blob: &[u8]) -> Vec<f32> {
    let mut out = Vec::with_capacity(blob.len() / 4);
    for chunk in blob.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryHit {
    pub id: i64,
    pub path: String,
    #[serde(rename = "startLine")]
    pub start_line: usize,
    #[serde(rename = "endLine")]
    pub end_line: usize,
    pub score: f32,
    pub snippet: String,
    pub source: String,
}

pub struct MemoryStore {
    conn: Mutex<Connection>,
    workspace_dir: PathBuf,
}

impl MemoryStore {
    pub fn open(db_path: &Path, workspace_dir: PathBuf) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)
            .with_context(|| format!("failed opening sqlite db at {}", db_path.display()))?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                content TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '',
                embedding BLOB NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                messages_json TEXT NOT NULL
            );
            ",
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
            workspace_dir,
        })
    }

    pub fn count(&self) -> usize {
        let Ok(conn) = self.conn.lock() else {
            return 0;
        };
        conn.query_row("SELECT COUNT(*) FROM memories", [], |row| row.get::<_, i64>(0))
            .unwrap_or(0)
            .max(0) as usize
    }

    pub fn save_memory(&self, source: &str, content: &str, tags: &str) -> Result<i64> {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return Ok(0);
        }
        let emb = compute_embedding_1024(trimmed);
        let blob = embedding_to_blob(&emb);
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("db mutex poisoned"))?;

        // Deduplicate exact same source+content
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM memories WHERE source = ?1 AND content = ?2 LIMIT 1",
                params![source, trimmed],
                |row| row.get(0),
            )
            .ok();
        if let Some(id) = existing {
            return Ok(id);
        }

        conn.execute(
            "INSERT INTO memories (source, content, tags, embedding) VALUES (?1, ?2, ?3, ?4)",
            params![source, trimmed, tags, blob],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<MemoryHit>> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let q_emb = compute_embedding_1024(q);
        let q_lower = q.to_lowercase();
        let q_words: HashSet<&str> = q_lower
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() >= 2)
            .collect();

        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("db mutex poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT id, source, content, embedding FROM memories ORDER BY id DESC LIMIT 1500",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })?;

        let mut scored = Vec::new();
        for row in rows {
            let (id, source, content, blob) = row?;
            let emb = blob_to_embedding(&blob);
            let cos = cosine_similarity(&q_emb, &emb).max(0.0);

            let c_lower = content.to_lowercase();
            let kw_hit = if c_lower.contains(&q_lower) {
                1.0_f32
            } else if !q_words.is_empty() {
                let matched = q_words.iter().filter(|w| c_lower.contains(**w)).count();
                matched as f32 / q_words.len() as f32
            } else {
                0.0
            };

            let score = 0.62 * cos + 0.38 * kw_hit;
            if score >= 0.14 || kw_hit >= 0.5 {
                let line_count = content.lines().count().max(1);
                let snippet: String = content.chars().take(360).collect();
                scored.push(MemoryHit {
                    id,
                    path: format!("memory/{}", id),
                    start_line: 1,
                    end_line: line_count,
                    score,
                    snippet,
                    source,
                });
            }
        }

        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        Ok(scored)
    }

    pub fn get_path(&self, req_path: &str, from_line: usize, lines: usize) -> Result<Value> {
        let p = req_path.trim();
        if let Some(id_str) = p.strip_prefix("memory/") {
            if let Ok(id) = id_str.parse::<i64>() {
                let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("db mutex poisoned"))?;
                let (source, content): (String, String) = conn.query_row(
                    "SELECT source, content FROM memories WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let sliced = slice_lines(&content, from_line, lines);
                return Ok(json!({ "path": p, "source": source, "text": sliced }));
            }
        }

        let resolved = if Path::new(p).is_absolute() {
            PathBuf::from(p)
        } else {
            self.workspace_dir.join(p)
        };
        let raw = std::fs::read_to_string(&resolved)
            .with_context(|| format!("failed reading memory path {}", resolved.display()))?;
        Ok(json!({
            "path": p,
            "resolved": resolved.display().to_string(),
            "text": slice_lines(&raw, from_line, lines)
        }))
    }
}

fn slice_lines(content: &str, from_line: usize, lines: usize) -> String {
    let start = from_line.saturating_sub(1);
    let take_n = if lines == 0 { 100 } else { lines };
    content
        .lines()
        .skip(start)
        .take(take_n)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Dispatch OpenClaw `/tools/invoke` payloads against Capri-RS local services.
pub fn dispatch_tool_invoke(
    store: &MemoryStore,
    tool: &str,
    args: &Value,
    config: &CapriConfig,
) -> Result<Value> {
    match tool {
        "memory_search" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let limit = args
                .get("maxResults")
                .and_then(|v| v.as_u64())
                .unwrap_or(6) as usize;
            let results = store.search(query, limit)?;
            Ok(json!({
                "ok": true,
                "tool": "memory_search",
                "results": results,
                "provider": "capri-core-sqlite-1024"
            }))
        }
        "memory_get" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let from = args.get("from").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
            let lines = args.get("lines").and_then(|v| v.as_u64()).unwrap_or(80) as usize;
            let res = store.get_path(path, from, lines)?;
            Ok(json!({ "ok": true, "tool": "memory_get", "result": res }))
        }
        "memory_save" => {
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let source = args.get("source").and_then(|v| v.as_str()).unwrap_or("agent");
            let tags = args.get("tags").and_then(|v| v.as_str()).unwrap_or("");
            let id = store.save_memory(source, content, tags)?;
            Ok(json!({ "ok": true, "tool": "memory_save", "id": id }))
        }
        "session_status" => Ok(json!({
            "ok": true,
            "runtime": "capri-rs",
            "language": config.language,
            "ttsVoice": config.tts_voice,
            "voiceEffect": config.voice_effect,
            "fullComputerAccess": config.full_computer_access,
            "memoryCount": store.count(),
        })),
        other => Ok(json!({
            "ok": false,
            "error": format!("tool '{}' requires client-side execution in capri-ui", other)
        })),
    }
}

fn decode_data_url(url: &str, idx: usize) -> Option<InlineImage> {
    let rest = url.strip_prefix("data:")?;
    let (meta, b64) = rest.split_once(";base64,")?;
    let mime = if meta.is_empty() { "image/png" } else { meta };
    let ext = match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    };
    let bytes = decode_base64(b64)?;
    Some(InlineImage {
        bytes,
        filename: format!("capri-frame-{}.{}", idx, ext),
        mime: mime.to_string(),
    })
}

/// Minimal dependency-free standard base64 decoder.
pub fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let mut table = [255u8; 256];
    for (i, b) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        .iter()
        .enumerate()
    {
        table[*b as usize] = i as u8;
    }
    let clean: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if clean.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity((clean.len() / 4) * 3);
    for chunk in clean.chunks_exact(4) {
        let a = table[chunk[0] as usize];
        let b = table[chunk[1] as usize];
        if a == 255 || b == 255 {
            return None;
        }
        let c = if chunk[2] == b'=' { 0 } else { table[chunk[2] as usize] };
        let d = if chunk[3] == b'=' { 0 } else { table[chunk[3] as usize] };
        if c == 255 || d == 255 {
            return None;
        }
        let n = ((a as u32) << 18) | ((b as u32) << 12) | ((c as u32) << 6) | (d as u32);
        out.push(((n >> 16) & 0xFF) as u8);
        if chunk[2] != b'=' {
            out.push(((n >> 8) & 0xFF) as u8);
        }
        if chunk[3] != b'=' {
            out.push((n & 0xFF) as u8);
        }
    }
    Some(out)
}

#[allow(dead_code)]
fn _unused(_: &HashMap<String, String>) {}
