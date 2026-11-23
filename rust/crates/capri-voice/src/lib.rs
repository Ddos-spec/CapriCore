use anyhow::{anyhow, Context, Result};
use flacenc::bitsink::ByteSink;
use flacenc::component::BitRepr;
use flacenc::error::Verify;
use flacenc::source::MemSource;
use regex::Regex;
use serde_json::Value;
use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::process::Stdio;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tracing::{debug, warn};
use uuid::Uuid;

pub const TARGET_TTS_SAMPLE_RATE: u32 = 24_000;
const GOOGLE_STT_DEFAULT_KEY: &str = "AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw";
const MAX_TTS_BYTES: usize = (TARGET_TTS_SAMPLE_RATE as usize) * 2 * 45;

pub struct VoiceEngine {
    http: reqwest::Client,
}

impl VoiceEngine {
    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        Ok(Self { http })
    }

    /// Synthesize speech into strict 24 kHz 16-bit mono PCM WAV matching CapriCore's external-tts contract.
    pub async fn synthesize_wav_24k(
        &self,
        text: &str,
        voice: Option<&str>,
        speed: Option<f32>,
    ) -> Result<Vec<u8>> {
        let clean = sanitize_tts_text(text);
        if clean.is_empty() {
            return encode_wav_24k(&[0i16; 2400]);
        }

        let target_voice = voice.unwrap_or("id-ID-GadisNeural");
        let spd = speed.unwrap_or(1.0).clamp(0.6, 1.8);

        let decoded_mono = match try_edge_tts(&clean, target_voice, spd).await {
            Ok(mp3) => decode_mp3_to_24k_mono(&mp3)?,
            Err(edge_err) => {
                warn!("edge-tts unavailable/failed ({}), falling back to Google translate_tts", edge_err);
                self.google_translate_tts_24k(&clean, target_voice).await?
            }
        };

        encode_wav_24k(&decoded_mono)
    }

    async fn google_translate_tts_24k(&self, text: &str, voice: &str) -> Result<Vec<i16>> {
        let tl = if voice.starts_with("en") { "en" } else { "id" };
        let chunks = split_tts_chunks(text, 180);
        let mut all_samples = Vec::new();

        for chunk in chunks {
            let url = format!(
                "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl={}&q={}",
                tl,
                url_encode(&chunk)
            );
            let resp = self
                .http
                .get(&url)
                .header("Referer", "https://translate.google.com/")
                .send()
                .await
                .context("translate_tts request failed")?;
            if !resp.status().is_success() {
                return Err(anyhow!("translate_tts returned status {}", resp.status()));
            }
            let bytes = resp.bytes().await?;
            let mut seg = decode_mp3_to_24k_mono(&bytes)?;
            all_samples.append(&mut seg);
            all_samples.extend_from_slice(&[0i16; 1800]);
        }
        Ok(all_samples)
    }

    /// Transcribe WAV/FLAC/OGG/MP3 audio via Google Chromium Speech v2 API.
    pub async fn transcribe_audio(&self, audio_bytes: &[u8], lang: &str) -> Result<String> {
        if audio_bytes.is_empty() {
            return Ok(String::new());
        }

        let (flac_bytes, sample_rate) = convert_audio_to_flac(audio_bytes)?;
        let stt_lang = if lang.trim().is_empty() { "id-ID" } else { lang.trim() };
        let key = std::env::var("CAPRI_GOOGLE_STT_KEY").unwrap_or_else(|_| GOOGLE_STT_DEFAULT_KEY.to_string());

        let url = format!(
            "https://www.google.com/speech-api/v2/recognize?client=chromium&lang={}&key={}&pFilter=0",
            url_encode(stt_lang),
            url_encode(&key)
        );

        let resp = self
            .http
            .post(&url)
            .header("Content-Type", format!("audio/x-flac; rate={}", sample_rate))
            .body(flac_bytes)
            .send()
            .await
            .context("Google Speech API request failed")?;

        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(anyhow!("Google Speech API status {}: {}", status, body));
        }

        parse_google_stt_ndjson(&body)
    }
}

fn find_edge_tts_bin() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("CAPRI_EDGE_TTS_BIN") {
        let p = PathBuf::from(custom);
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join(".capri-rs/venv/bin/edge-tts");
        if p.exists() {
            return Some(p);
        }
    }
    if PathBuf::from("/usr/bin/edge-tts").exists() {
        return Some(PathBuf::from("/usr/bin/edge-tts"));
    }
    None
}

async fn try_edge_tts(text: &str, voice: &str, speed: f32) -> Result<Vec<u8>> {
    let bin = find_edge_tts_bin().ok_or_else(|| anyhow!("edge-tts binary not found"))?;
    let tmp_path = std::env::temp_dir().join(format!("capri-tts-{}.mp3", Uuid::new_v4()));
    let pct = ((speed - 1.0) * 100.0).round() as i32;
    let rate_arg = if pct >= 0 {
        format!("+{}%", pct)
    } else {
        format!("{}%", pct)
    };

    let output = tokio::process::Command::new(&bin)
        .arg("--voice")
        .arg(voice)
        .arg("--rate")
        .arg(&rate_arg)
        .arg("--text")
        .arg(text)
        .arg("--write-media")
        .arg(&tmp_path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("failed spawning edge-tts")?;

    let mp3_res = std::fs::read(&tmp_path);
    let _ = std::fs::remove_file(&tmp_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("edge-tts exited {}: {}", output.status, stderr));
    }

    let bytes = mp3_res.context("failed reading edge-tts temp output")?;
    if bytes.is_empty() {
        return Err(anyhow!("edge-tts produced 0 bytes"));
    }
    Ok(bytes)
}

fn decode_mp3_to_24k_mono(mp3_bytes: &[u8]) -> Result<Vec<i16>> {
    let cursor = Cursor::new(mp3_bytes.to_vec());
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("mp3");

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .context("symphonia MP3 probe failed")?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| anyhow!("no default audio track in MP3"))?;
    let track_id = track.id;
    let src_rate = track.codec_params.sample_rate.unwrap_or(24_000);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .context("symphonia decoder creation failed")?;

    let mut mono_f32 = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(_) => continue,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(_) => break,
        };

        let spec = *decoded.spec();
        let actual_channels = spec.channels.count().max(1);
        if sample_buf.is_none() || sample_buf.as_ref().unwrap().capacity() < decoded.capacity() {
            sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        if let Some(buf) = &mut sample_buf {
            buf.copy_interleaved_ref(decoded);
            let samples = buf.samples();
            for frame in samples.chunks_exact(actual_channels) {
                let sum: f32 = frame.iter().copied().sum();
                mono_f32.push((sum / actual_channels as f32).clamp(-1.0, 1.0));
            }
        }
    }

    if mono_f32.is_empty() {
        return Err(anyhow!("MP3 decoded 0 samples"));
    }

    let resampled = if src_rate == TARGET_TTS_SAMPLE_RATE {
        mono_f32
    } else {
        resample_linear(&mono_f32, src_rate, TARGET_TTS_SAMPLE_RATE)
    };

    let max_samples = MAX_TTS_BYTES / 2;
    let out: Vec<i16> = resampled
        .into_iter()
        .take(max_samples)
        .map(|s| (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
        .collect();
    Ok(out)
}

fn resample_linear(input: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if input.is_empty() || src_rate == 0 || dst_rate == 0 {
        return Vec::new();
    }
    let ratio = dst_rate as f64 / src_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = (i as f64) / ratio;
        let idx = src_pos.floor() as usize;
        let frac = (src_pos - idx as f64) as f32;
        let s0 = input.get(idx).copied().unwrap_or(0.0);
        let s1 = input.get(idx + 1).copied().unwrap_or(s0);
        out.push(s0 + (s1 - s0) * frac);
    }
    out
}

fn encode_wav_24k(samples: &[i16]) -> Result<Vec<u8>> {
    let mut cursor = Cursor::new(Vec::with_capacity(44 + samples.len() * 2));
    {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: TARGET_TTS_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::new(&mut cursor, spec)?;
        for &s in samples {
            writer.write_sample(s)?;
        }
        writer.finalize()?;
    }
    Ok(cursor.into_inner())
}

fn convert_audio_to_flac(bytes: &[u8]) -> Result<(Vec<u8>, u32)> {
    // Case 1: Already FLAC
    if bytes.starts_with(b"fLaC") && bytes.len() >= 22 {
        let sr = (((bytes[18] as u32) << 12) | ((bytes[19] as u32) << 4) | ((bytes[20] as u32) >> 4))
            .max(8000);
        return Ok((bytes.to_vec(), sr));
    }

    // Case 2: RIFF/WAVE -> pure-Rust decode via hound + pure-Rust FLAC encode via flacenc
    if bytes.starts_with(b"RIFF") {
        let mut reader = hound::WavReader::new(Cursor::new(bytes))?;
        let spec = reader.spec();
        let ch = spec.channels.max(1) as usize;
        let raw_mono: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Float => {
                let all: Vec<f32> = reader.samples::<f32>().filter_map(Result::ok).collect();
                all.chunks(ch)
                    .map(|f| f.iter().copied().sum::<f32>() / ch as f32)
                    .collect()
            }
            hound::SampleFormat::Int => {
                let scale = ((1i64 << (spec.bits_per_sample.saturating_sub(1).max(1))) - 1) as f32;
                let all: Vec<i32> = reader.samples::<i32>().filter_map(Result::ok).collect();
                all.chunks(ch)
                    .map(|f| (f.iter().copied().sum::<i32>() as f32 / ch as f32) / scale)
                    .collect()
            }
        };

        let target_rate = if spec.sample_rate < 8000 { 16_000 } else { spec.sample_rate };
        let mono = if target_rate != spec.sample_rate {
            resample_linear(&raw_mono, spec.sample_rate, target_rate)
        } else {
            raw_mono
        };

        let i32_samples: Vec<i32> = mono
            .into_iter()
            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0).round() as i32)
            .collect();

        let config = flacenc::config::Encoder::default()
            .into_verified()
            .map_err(|(_, e)| anyhow!("flacenc config invalid: {:?}", e))?;
        let source = MemSource::from_samples(&i32_samples, 1, 16, target_rate as usize);
        let flac_stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
            .map_err(|e| anyhow!("flacenc encode error: {:?}", e))?;
        let mut sink = ByteSink::new();
        flac_stream
            .write(&mut sink)
            .map_err(|e| anyhow!("flacenc ByteSink write error: {:?}", e))?;
        debug!("Encoded WAV {}Hz -> FLAC {} bytes", target_rate, sink.as_slice().len());
        return Ok((sink.as_slice().to_vec(), target_rate));
    }

    // Case 3: WebM/Ogg/MP3 -> convert via ffmpeg subprocess if present
    let ffmpeg = if PathBuf::from("/usr/bin/ffmpeg").exists() {
        PathBuf::from("/usr/bin/ffmpeg")
    } else {
        PathBuf::from("ffmpeg")
    };
    let mut child = std::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "flac", "pipe:1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("non-WAV audio requires ffmpeg installed")?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(bytes)?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() || output.stdout.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("ffmpeg conversion to FLAC failed: {}", err));
    }
    Ok((output.stdout, 16_000))
}

fn parse_google_stt_ndjson(body: &str) -> Result<String> {
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(t) else {
            continue;
        };
        let Some(results) = val.get("result").and_then(|v| v.as_array()) else {
            continue;
        };
        if results.is_empty() {
            continue;
        }
        if let Some(alts) = results[0].get("alternative").and_then(|v| v.as_array()) {
            if let Some(transcript) = alts.first().and_then(|a| a.get("transcript")).and_then(|s| s.as_str()) {
                return Ok(transcript.trim().to_string());
            }
        }
    }
    Ok(String::new())
}

fn sanitize_tts_text(raw: &str) -> String {
    let cite_re = Regex::new(r"\[cite:[^\]]*\]").unwrap();
    let md_re = Regex::new(r"[`*_#>~]").unwrap();
    let no_cite = cite_re.replace_all(raw, "");
    let no_md = md_re.replace_all(&no_cite, " ");
    no_md.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn split_tts_chunks(text: &str, max_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        if current.len() + word.len() + 1 > max_chars && !current.is_empty() {
            chunks.push(current.clone());
            current.clear();
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else if b == b' ' {
            out.push_str("%20");
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}
