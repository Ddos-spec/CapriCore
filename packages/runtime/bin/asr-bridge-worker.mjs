// SPDX-License-Identifier: GPL-3.0-only
import { Buffer } from 'node:buffer';

const SAMPLE_RATE = 16000;
const LANGUAGE = process.env.CAPRI_ASR_LANGUAGE || 'id';
const STT_URL = process.env.CAPRI_STT_SIDECAR_URL || 'http://127.0.0.1:19823/api/stt';

const LANG_MAP = {
  id: 'id-ID',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'zh-CN',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  ru: 'ru-RU',
  ar: 'ar-SA',
  pt: 'pt-BR',
  it: 'it-IT',
  nl: 'nl-NL',
  tr: 'tr-TR',
  vi: 'vi-VN',
  th: 'th-TH',
  ms: 'ms-MY',
};

function resolvePrimaryLocale(lang) {
  if (!lang || ['auto', 'auto-europe', 'follow'].includes(lang)) return 'id-ID';
  return LANG_MAP[lang] || (lang.includes('-') ? lang : `${lang}-${lang.toUpperCase()}`);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function clampPause(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 1.0;
  return Math.max(0.4, Math.min(5.0, n));
}

function concatFloat32(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function computeRms(f32) {
  if (!f32.length) return 0;
  let sum = 0;
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i];
    sum += v * v;
  }
  return Math.sqrt(sum / f32.length);
}

function float32ToWav16kMono(f32) {
  const numSamples = f32.length;
  const dataBytes = numSamples * 2;
  const buf = Buffer.allocUnsafe(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < numSamples; i++) {
    let s = f32[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    buf.writeInt16LE(s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

function buildWakeBoundaries(text, totalSamples) {
  const boundaries = [];
  const clean = String(text || '');
  const matches = [...clean.matchAll(/[\p{L}\p{N}]+/gu)].slice(0, 64);
  const len = Math.max(1, clean.length);
  for (const m of matches) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const startSample = Math.max(0, Math.floor((start / len) * totalSamples));
    const endSample = Math.max(startSample + 1, Math.floor((end / len) * totalSamples));
    boundaries.push({ start, end, startSample, endSample });
  }
  return boundaries;
}

async function callStt(wavBase64, locale) {
  const resp = await fetch(STT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ wav_base64: wavBase64, lang: locale }),
  });
  if (!resp.ok) return { success: false, text: '' };
  const data = await resp.json().catch(() => null);
  return data && typeof data === 'object' ? data : { success: false, text: '' };
}

async function transcribeSamples(samples) {
  const wavBuf = float32ToWav16kMono(samples);
  const wavBase64 = wavBuf.toString('base64');
  const primaryLocale = resolvePrimaryLocale(LANGUAGE);
  let res = await callStt(wavBase64, primaryLocale);
  if ((!res?.success || !String(res.text || '').trim()) && samples.length >= SAMPLE_RATE * 0.45) {
    const fallbackLocale = primaryLocale === 'en-US' ? 'id-ID' : 'en-US';
    const retry = await callStt(wavBase64, fallbackLocale);
    if (retry?.success && String(retry.text || '').trim()) {
      res = retry;
    }
  }
  return String(res?.text || '').trim();
}

emit({ type: 'startup-stage', code: 'ASR_START_DEPENDENCIES' });
emit({ type: 'startup-stage', code: 'ASR_START_CONFIG' });
emit({ type: 'startup-stage', code: 'ASR_START_DETECTOR' });
emit({ type: 'startup-stage', code: 'ASR_START_MODEL' });
emit({
  type: 'ready',
  protocol: 1,
  language: LANGUAGE,
  sampleRate: SAMPLE_RATE,
  provider: 'cpu',
  engine: 'capri-stt-bridge',
  mode: 'utterance',
  draft: false,
});

let sessionId = null;
let sessionGeneration = 0;
let trailingSilenceSeconds = 1.0;
let attention = true;
let utterance = 0;

let speaking = false;
let speechChunks = [];
let speechSamples = 0;
let silenceSamples = 0;
let noiseFloor = 0.003;
const preRollChunks = [];
let preRollSamples = 0;
const MAX_PREROLL_SAMPLES = Math.floor(SAMPLE_RATE * 0.35);

let recognizeChain = Promise.resolve();

function resetUtteranceState() {
  speaking = false;
  speechChunks = [];
  speechSamples = 0;
  silenceSamples = 0;
  preRollChunks.length = 0;
  preRollSamples = 0;
}

function enqueueRecognition(samples, uttId, sid, gen, needWakeCandidate) {
  const t0 = performance.now();
  const audioSeconds = Number((samples.length / SAMPLE_RATE).toFixed(3));
  recognizeChain = recognizeChain
    .then(async () => {
      if (gen !== sessionGeneration || sessionId !== sid) return;
      const text = await transcribeSamples(samples);
      if (gen !== sessionGeneration || sessionId !== sid || !text) return;
      const recognitionMs = Math.max(1, Math.round(performance.now() - t0));
      if (needWakeCandidate) {
        emit({
          type: 'wake-candidate',
          sessionId: sid,
          text: text.slice(0, 4096),
          utterance: uttId,
          boundaries: buildWakeBoundaries(text.slice(0, 4096), samples.length),
        });
      }
      emit({
        type: 'transcript',
        sessionId: sid,
        text: text.slice(0, 4096),
        final: true,
        utterance: uttId,
        recognitionMs,
        audioSeconds,
      });
    })
    .catch(() => {});
}

function pushPreRoll(chunk) {
  if (!chunk.length) return;
  preRollChunks.push(chunk);
  preRollSamples += chunk.length;
  while (preRollSamples > MAX_PREROLL_SAMPLES && preRollChunks.length > 1) {
    const removed = preRollChunks.shift();
    preRollSamples -= removed.length;
  }
}

function finalizeUtterance(force) {
  if (!speaking) return;
  const minSamples = force ? Math.floor(SAMPLE_RATE * 0.14) : Math.floor(SAMPLE_RATE * 0.18);
  if (speechSamples < minSamples) {
    resetUtteranceState();
    return;
  }
  const merged = concatFloat32(speechChunks);
  const uttId = utterance++;
  const sid = sessionId;
  const gen = sessionGeneration;
  const needWakeCandidate = !attention;
  resetUtteranceState();
  emit({ type: 'recognition-state', sessionId: sid, phase: 'processing', utterance: uttId });
  enqueueRecognition(merged, uttId, sid, gen, needWakeCandidate);
}

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let nl;
  while ((nl = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, nl).trim();
    stdinBuffer = stdinBuffer.slice(nl + 1);
    if (!line) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = cmd?.type;
    const reqId = cmd?.request;
    if (kind === 'start') {
      sessionId = typeof cmd.sessionId === 'string' ? cmd.sessionId : null;
      sessionGeneration++;
      trailingSilenceSeconds = clampPause(cmd.trailingSilenceSeconds ?? 1.0);
      attention = cmd.attention !== false;
      utterance = 0;
      resetUtteranceState();
      emit({ type: 'ack', request: reqId });
    } else if (kind === 'stop') {
      if (!cmd.sessionId || cmd.sessionId === sessionId) {
        sessionId = null;
        sessionGeneration++;
        resetUtteranceState();
      }
      emit({ type: 'ack', request: reqId });
    } else if (kind === 'configure') {
      if (!sessionId || cmd.sessionId !== sessionId) {
        emit({ type: 'error', request: reqId, code: 'ASR_INACTIVE_SESSION' });
        continue;
      }
      trailingSilenceSeconds = clampPause(cmd.trailingSilenceSeconds);
      emit({ type: 'ack', request: reqId });
    } else if (kind === 'attention') {
      if (!sessionId || cmd.sessionId !== sessionId) {
        emit({ type: 'error', request: reqId, code: 'ASR_INACTIVE_SESSION' });
        continue;
      }
      attention = Boolean(cmd.active);
      emit({ type: 'ack', request: reqId });
    } else if (kind === 'pcm' || kind === 'finish') {
      if (!sessionId || cmd.sessionId !== sessionId) {
        emit({ type: 'error', request: reqId, code: 'ASR_INACTIVE_SESSION' });
        continue;
      }
      const rawB64 = typeof cmd.pcm === 'string' ? cmd.pcm : '';
      const rawBuf = rawB64 ? Buffer.from(rawB64, 'base64') : Buffer.alloc(0);
      if (rawBuf.length % 4 !== 0 || rawBuf.length > 12800) {
        emit({ type: 'error', request: reqId, code: 'ASR_INVALID_PCM' });
        continue;
      }
      emit({ type: 'ack', request: reqId });
      const samples = new Float32Array(
        rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength),
      );
      if (samples.length > 0) {
        const rms = computeRms(samples);
        const startThresh = Math.max(0.011, noiseFloor * 2.5);
        const sustainThresh = Math.max(0.008, noiseFloor * 1.8);
        if (!speaking) {
          pushPreRoll(samples);
          if (rms >= startThresh) {
            speaking = true;
            silenceSamples = 0;
            speechChunks = [...preRollChunks];
            speechSamples = preRollSamples;
            preRollChunks.length = 0;
            preRollSamples = 0;
            emit({ type: 'recognition-state', sessionId, phase: 'speech', utterance });
          } else if (rms < 0.04) {
            noiseFloor = Math.max(0.001, Math.min(0.025, noiseFloor * 0.92 + rms * 0.08));
          }
        } else {
          speechChunks.push(samples);
          speechSamples += samples.length;
          if (rms >= sustainThresh) silenceSamples = 0;
          else silenceSamples += samples.length;

          if (speechSamples >= SAMPLE_RATE * 28) {
            const cur = utterance++;
            resetUtteranceState();
            emit({
              type: 'recognition-reset',
              sessionId,
              utterance: cur,
              nextUtterance: utterance,
              reason: 'utterance_limit',
            });
          } else if (
            kind === 'finish' ||
            silenceSamples >= Math.floor(trailingSilenceSeconds * SAMPLE_RATE) ||
            speechSamples >= SAMPLE_RATE * 18
          ) {
            finalizeUtterance(kind === 'finish');
          }
        }
      } else if (kind === 'finish') {
        finalizeUtterance(true);
      }
    } else if (kind === 'quit') {
      emit({ type: 'ack', request: reqId });
      process.exit(0);
    } else {
      emit({ type: 'error', request: reqId, code: 'ASR_PACKET_REJECTED' });
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
