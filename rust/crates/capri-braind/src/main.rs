use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use capri_core::{
    build_gemini_prompt, compute_embedding_1024, dispatch_tool_invoke, parse_tool_calls,
    strip_citations_and_artifacts, CapriConfig, MemoryStore, OpenAiChatRequest,
};
use capri_gemini::GeminiClient;
use capri_voice::{VoiceEngine, TARGET_TTS_SAMPLE_RATE};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info, warn};
use uuid::Uuid;

struct AppState {
    config: CapriConfig,
    gemini: Arc<GeminiClient>,
    voice: Arc<VoiceEngine>,
    memory: Arc<MemoryStore>,
    started_at: Instant,
}

#[derive(Debug, Deserialize)]
struct CookiesPayload {
    #[serde(default)]
    psid: String,
    #[serde(default)]
    psidts: String,
    #[serde(default, alias = "cookieHeader")]
    cookie_header: String,
}

#[derive(Debug, Deserialize)]
struct SpeechRequest {
    input: String,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    speed: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct MemorySearchQuery {
    #[serde(default)]
    q: String,
    #[serde(default = "default_mem_limit")]
    limit: usize,
}

fn default_mem_limit() -> usize {
    8
}

#[derive(Debug, Deserialize)]
struct MemoryPostPayload {
    content: String,
    #[serde(default = "default_mem_source")]
    source: String,
    #[serde(default)]
    tags: String,
}

fn default_mem_source() -> String {
    "user".to_string()
}

#[derive(Debug, Deserialize)]
struct ToolsInvokePayload {
    tool: String,
    #[serde(default)]
    args: Value,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let config = CapriConfig::from_env();
    std::fs::create_dir_all(&config.data_dir)?;

    let memory = Arc::new(MemoryStore::open(
        &config.memory_db_path(),
        config.workspace_dir.clone(),
    )?);
    let gemini = Arc::new(GeminiClient::new(
        config.cookies_path(),
        config.gemini_fallback_url.clone(),
    )?);
    gemini.warm_start().await;
    gemini.spawn_rotation_task();

    let voice = Arc::new(VoiceEngine::new()?);
    voice.warm_start().await;

    let state = Arc::new(AppState {
        config: config.clone(),
        gemini,
        voice,
        memory,
        started_at: Instant::now(),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/startupz", get(health_handler))
        .route("/readyz", get(health_handler))
        .route("/v1/models", get(models_handler))
        .route("/v1/chat/completions", post(chat_completions_handler))
        .route("/v1/audio/speech", post(audio_speech_handler))
        .route("/v1/audio/transcriptions", post(audio_transcriptions_handler))
        .route("/api/version", get(ollama_version_handler))
        .route("/api/tags", get(ollama_tags_handler))
        .route("/api/ps", get(ollama_ps_handler))
        .route("/api/embed", post(embeddings_handler))
        .route("/api/embeddings", post(embeddings_handler))
        .route("/v1/embeddings", post(embeddings_handler))
        .route("/tools/invoke", post(tools_invoke_handler))
        .route("/api/cookies", post(post_cookies_handler))
        .route("/api/memory", get(get_memory_handler).post(post_memory_handler))
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(cors)
        .with_state(state);

    info!("capri-braind listening on http://{}", config.bind_addr);
    let listener = tokio::net::TcpListener::bind(&config.bind_addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health_handler(State(st): State<Arc<AppState>>) -> impl IntoResponse {
    let (has_cookies, wiz_ok) = st.gemini.status().await;
    Json(json!({
        "ok": true,
        "service": "capri-braind",
        "gemini_ready": has_cookies,
        "wiz_ok": wiz_ok,
        "uptime_sec": st.started_at.elapsed().as_secs(),
        "memory_entries": st.memory.count(),
        "voice": st.config.tts_voice,
        "language": st.config.language,
    }))
}

async fn models_handler() -> impl IntoResponse {
    let created = now_secs();
    Json(json!({
        "object": "list",
        "data": [
            { "id": "capri-gemini-flash", "object": "model", "created": created, "owned_by": "capri-rs" },
            { "id": "gemini-2.5-flash", "object": "model", "created": created, "owned_by": "google-web" },
            { "id": "capri-gemini", "object": "model", "created": created, "owned_by": "capri-rs" },
            { "id": "nomic-embed-text:latest", "object": "model", "created": created, "owned_by": "capri-core" }
        ]
    }))
}

async fn chat_completions_handler(
    State(st): State<Arc<AppState>>,
    Json(req): Json<OpenAiChatRequest>,
) -> Response {
    let wants_stream = req.stream.unwrap_or(false);
    let recalled = if let Some(last_user) = req
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
    {
        let q = match &last_user.content {
            capri_core::MessageContent::Text(s) => s.as_str(),
            _ => "",
        };
        st.memory.search(q, 4).unwrap_or_default()
    } else {
        Vec::new()
    };

    let (prompt, latest_user, images, allowed_tools) =
        build_gemini_prompt(&req.messages, req.tools.as_deref(), &recalled);

    let raw_reply = match st.gemini.generate(&prompt, images, true).await {
        Ok(r) => r,
        Err(e) => {
            error!("Gemini generation failed: {}", e);
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": { "message": e.to_string(), "type": "gemini_upstream_error" } })),
            )
                .into_response();
        }
    };

    let mut clean_reply = strip_citations_and_artifacts(&raw_reply);
    let tool_calls = parse_tool_calls(&clean_reply, &allowed_tools);
    if tool_calls.is_none() && capri_core::looks_like_refusal(&clean_reply) {
        warn!("Gemini returned refusal ({:?}); retrying lean tool-free turn", clean_reply.chars().take(60).collect::<String>());
        let lean_msgs: Vec<_> = req
            .messages
            .iter()
            .filter(|m| m.role != "system")
            .cloned()
            .collect();
        let start = lean_msgs.len().saturating_sub(6);
        let (retry_prompt, _, _, _) = build_gemini_prompt(&lean_msgs[start..], None, &recalled);
        if let Ok(retry_raw) = st.gemini.generate(&retry_prompt, Vec::new(), true).await {
            let retry_clean = strip_citations_and_artifacts(&retry_raw);
            if !retry_clean.is_empty() && !capri_core::looks_like_refusal(&retry_clean) {
                clean_reply = retry_clean;
            }
        }
    }
    info!(
        "CHAT user={:?} -> tools={} reply={:?}",
        latest_user.chars().take(60).collect::<String>(),
        tool_calls.as_ref().map(|v| v.len()).unwrap_or(0),
        clean_reply.chars().take(80).collect::<String>()
    );

    // Persist notable user memories passively in SQLite
    if latest_user.len() >= 18 && !latest_user.starts_with('[') && tool_calls.is_none() {
        let lower = latest_user.to_lowercase();
        if lower.contains("ingat")
            || lower.contains("nama gua")
            || lower.contains("nama saya")
            || lower.contains("panggil")
            || lower.contains("remember")
        {
            let _ = st.memory.save_memory("chat_fact", &latest_user, "auto");
        }
    }

    let id = format!("chatcmpl-{}", &Uuid::new_v4().to_string()[..12]);
    let created = now_secs();

    if wants_stream {
        let sse = build_openai_sse_payload(&id, created, &req.model, &clean_reply, tool_calls.as_deref());
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(sse))
            .unwrap();
    }

    let message = if let Some(tcs) = &tool_calls {
        json!({
            "role": "assistant",
            "content": Value::Null,
            "tool_calls": tcs
        })
    } else {
        json!({
            "role": "assistant",
            "content": clean_reply
        })
    };

    let finish_reason = if tool_calls.is_some() { "tool_calls" } else { "stop" };
    Json(json!({
        "id": id,
        "object": "chat.completion",
        "created": created,
        "model": req.model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason
        }],
        "usage": {
            "prompt_tokens": (prompt.len() / 4).max(1),
            "completion_tokens": (clean_reply.len() / 4).max(1),
            "total_tokens": ((prompt.len() + clean_reply.len()) / 4).max(2)
        }
    }))
    .into_response()
}

fn build_openai_sse_payload(
    id: &str,
    created: u64,
    model: &str,
    text: &str,
    tool_calls: Option<&[capri_core::ToolCall]>,
) -> String {
    let mut out = String::new();
    if let Some(tcs) = tool_calls {
        let delta_chunk = json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": { "role": "assistant", "tool_calls": tcs },
                "finish_reason": Value::Null
            }]
        });
        out.push_str(&format!("data: {}\n\n", delta_chunk));
        let end_chunk = json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }]
        });
        out.push_str(&format!("data: {}\n\n", end_chunk));
    } else {
        let chunk = json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": { "role": "assistant", "content": text },
                "finish_reason": Value::Null
            }]
        });
        out.push_str(&format!("data: {}\n\n", chunk));
        let end_chunk = json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
        });
        out.push_str(&format!("data: {}\n\n", end_chunk));
    }
    out.push_str("data: [DONE]\n\n");
    out
}

async fn audio_speech_handler(
    State(st): State<Arc<AppState>>,
    Json(req): Json<SpeechRequest>,
) -> Response {
    let voice = req.voice.as_deref().unwrap_or(&st.config.tts_voice);
    match st.voice.synthesize_wav_24k(&req.input, Some(voice), req.speed).await {
        Ok(wav) => {
            info!("TTS len={} voice={} -> {}B", req.input.len(), voice, wav.len());
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "audio/wav")
                .header("X-Sample-Rate", HeaderValue::from_static("24000"))
                .header("X-Channels", HeaderValue::from_static("1"))
                .header("X-Bits-Per-Sample", HeaderValue::from_static("16"))
                .body(Body::from(wav))
                .unwrap()
        }
        Err(e) => {
            error!("TTS synthesis failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": e.to_string(), "target_rate": TARGET_TTS_SAMPLE_RATE })),
            )
                .into_response()
        }
    }
}

async fn audio_transcriptions_handler(
    State(st): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Response {
    let mut audio_bytes = Vec::new();
    let mut lang = st.config.language.clone();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            if let Ok(bytes) = field.bytes().await {
                audio_bytes = bytes.to_vec();
            }
        } else if name == "language" {
            if let Ok(txt) = field.text().await {
                if !txt.trim().is_empty() {
                    lang = txt.trim().to_string();
                }
            }
        }
    }

    if audio_bytes.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing 'file' audio field" })),
        )
            .into_response();
    }

    match st.voice.transcribe_audio(&audio_bytes, &lang).await {
        Ok(text) => Json(json!({ "text": text, "language": lang })).into_response(),
        Err(e) => {
            error!("STT failed: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    }
}

async fn ollama_version_handler() -> impl IntoResponse {
    Json(json!({ "version": "0.6.0-capri-rs" }))
}

async fn ollama_tags_handler() -> impl IntoResponse {
    Json(json!({
        "models": [{
            "name": "nomic-embed-text:latest",
            "model": "nomic-embed-text:latest",
            "size": 0,
            "digest": "capri-core-1024",
            "details": { "family": "hash-trigram-1024", "parameter_size": "0MB" }
        }]
    }))
}

async fn ollama_ps_handler() -> impl IntoResponse {
    Json(json!({ "models": [] }))
}

async fn embeddings_handler(Json(payload): Json<Value>) -> impl IntoResponse {
    let inputs: Vec<String> = if let Some(s) = payload.get("input").and_then(|v| v.as_str()) {
        vec![s.to_string()]
    } else if let Some(arr) = payload.get("input").and_then(|v| v.as_array()) {
        arr.iter()
            .filter_map(|v| v.as_str().map(ToString::to_string))
            .collect()
    } else if let Some(s) = payload.get("prompt").and_then(|v| v.as_str()) {
        vec![s.to_string()]
    } else {
        vec![String::new()]
    };

    let vecs: Vec<Vec<f32>> = inputs.iter().map(|t| compute_embedding_1024(t)).collect();
    if payload.get("prompt").is_some() {
        return Json(json!({ "embedding": vecs.first().cloned().unwrap_or_default() }));
    }
    if payload.get("model").is_some() && payload.get("input").is_some() {
        let data: Vec<Value> = vecs
            .iter()
            .enumerate()
            .map(|(i, emb)| json!({ "object": "embedding", "index": i, "embedding": emb }))
            .collect();
        return Json(json!({
            "object": "list",
            "data": data,
            "embeddings": vecs,
            "model": "nomic-embed-text:latest"
        }));
    }
    Json(json!({ "embeddings": vecs, "model": "nomic-embed-text:latest" }))
}

async fn tools_invoke_handler(
    State(st): State<Arc<AppState>>,
    Json(payload): Json<ToolsInvokePayload>,
) -> Response {
    match dispatch_tool_invoke(&st.memory, &payload.tool, &payload.args, &st.config) {
        Ok(res) => Json(res).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn post_cookies_handler(
    State(st): State<Arc<AppState>>,
    Json(payload): Json<CookiesPayload>,
) -> Response {
    match st
        .gemini
        .set_cookies(payload.psid, payload.psidts, payload.cookie_header)
        .await
    {
        Ok(status) => Json(status).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "wiz_ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn get_memory_handler(
    State(st): State<Arc<AppState>>,
    Query(q): Query<MemorySearchQuery>,
) -> Response {
    if q.q.trim().is_empty() {
        return Json(json!({ "ok": true, "count": st.memory.count(), "results": [] })).into_response();
    }
    match st.memory.search(&q.q, q.limit) {
        Ok(hits) => Json(json!({ "ok": true, "count": st.memory.count(), "results": hits })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn post_memory_handler(
    State(st): State<Arc<AppState>>,
    Json(payload): Json<MemoryPostPayload>,
) -> Response {
    match st
        .memory
        .save_memory(&payload.source, &payload.content, &payload.tags)
    {
        Ok(id) => Json(json!({ "ok": true, "id": id, "count": st.memory.count() })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
