// SPDX-License-Identifier: GPL-3.0-only
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.CAPRI_GEMINI_BRIDGE_PORT) || 19825;
const GEMINI_URL = process.env.CAPRI_GEMINI_DESKTOP_URL || 'http://127.0.0.1:19824';
const TTS_URL = process.env.CAPRI_TTS_SIDECAR_URL || 'http://127.0.0.1:19823';
const MODEL_ID = 'gemini-flash-capri';
const MAX_PCM_BYTES = 24000 * 2 * 45;
const LOG_DIR = 'D:/code/CapriCore/logs';
const LOG_FILE = path.join(LOG_DIR, 'gemini-bridge.log');

function logBridge(level, msg) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 512 * 1024) {
      writeFileSync(LOG_FILE, '');
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] ${msg}\n`);
  } catch {}
}

process.on('uncaughtException', (err) => {
  logBridge('ERROR', `uncaughtException: ${err?.stack || err?.message || String(err)}`);
});
process.on('unhandledRejection', (err) => {
  logBridge('ERROR', `unhandledRejection: ${err?.stack || err?.message || String(err)}`);
});

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function sendJson(res, status, payload) {
  res.writeHead(status, jsonHeaders).end(JSON.stringify(payload));
}

async function readJsonBody(req, limitBytes = 24 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw Object.assign(new Error('Request payload too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object') return value;
  } catch {}
  throw Object.assign(new Error('Invalid JSON payload'), { status: 400 });
}

async function checkUpstreams() {
  const probe = async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const data = await r.json().catch(() => null);
      return Boolean(r.ok && (!data || data.success !== false));
    } catch {
      return false;
    }
  };
  const [geminiOk, ttsOk] = await Promise.all([
    probe(`${GEMINI_URL}/status`),
    probe(`${TTS_URL}/api/health`),
  ]);
  return { geminiOk, ttsOk };
}

function summarizeSchema(schema, maxLen = 650) {
  if (!schema || typeof schema !== 'object') return '{}';
  try {
    const compact = {};
    if (schema.type) compact.type = schema.type;
    if (Array.isArray(schema.required) && schema.required.length) compact.required = schema.required;
    if (schema.properties && typeof schema.properties === 'object') {
      compact.properties = {};
      for (const [k, v] of Object.entries(schema.properties)) {
        if (!v || typeof v !== 'object') continue;
        const prop = {};
        if (v.type) prop.type = v.type;
        if (Array.isArray(v.enum)) prop.enum = v.enum.slice(0, 16);
        if (typeof v.description === 'string' && v.description.trim()) {
          prop.desc = v.description.trim().slice(0, 100);
        }
        if (v.items && typeof v.items === 'object' && v.items.type) prop.items = v.items.type;
        compact.properties[k] = prop;
      }
    }
    const raw = JSON.stringify(Object.keys(compact).length ? compact : schema);
    return raw.length > maxLen ? raw.slice(0, maxLen) + '...' : raw;
  } catch {
    return '{}';
  }
}

function extractMessagesAndImages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const rawImages = [];
  const lines = [];

  for (const msg of list) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || 'user').toUpperCase();
    const parts = [];

    if (typeof msg.content === 'string') {
      if (msg.content.trim()) parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          if (part.text.trim()) parts.push(part.text);
        } else if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') {
          const url =
            typeof part.image_url === 'string'
              ? part.image_url
              : part.image_url?.url || part.url || '';
          if (typeof url === 'string' && url.startsWith('data:image/')) {
            const idx = rawImages.length;
            rawImages.push({
              markerIndex: idx,
              url,
              filename: `frame_${idx + 1}.png`,
            });
            parts.push(`[[IMAGE_SLOT_${idx}]]`);
          } else if (url) {
            parts.push(`[Image URL: ${String(url).slice(0, 120)}]`);
          }
        }
      }
    }

    if (Array.isArray(msg.images)) {
      for (const b64 of msg.images) {
        if (typeof b64 !== 'string' || !b64.trim()) continue;
        const url = b64.startsWith('data:image/') ? b64 : `data:image/png;base64,${b64.trim()}`;
        const idx = rawImages.length;
        rawImages.push({
          markerIndex: idx,
          url,
          filename: `frame_${idx + 1}.png`,
        });
        parts.push(`[[IMAGE_SLOT_${idx}]]`);
      }
    }

    if (role === 'ASSISTANT' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const tcStr = msg.tool_calls
        .map((c) => {
          const fn = c?.function || c;
          return `${fn?.name || 'tool'}(${typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {})})`;
        })
        .join(', ');
      parts.push(`[Called tools: ${tcStr}]`);
    }

    if (role === 'TOOL') {
      const label = [msg.name ? `name=${msg.name}` : '', msg.tool_call_id ? `id=${msg.tool_call_id}` : '']
        .filter(Boolean)
        .join(' ');
      lines.push(`[TOOL RESULT${label ? ' ' + label : ''}]: ${parts.join('\n')}`);
    } else if (parts.length) {
      lines.push(`[${role}]: ${parts.join('\n')}`);
    }
  }

  const MAX_IMAGES = 6;
  const startIdx = Math.max(0, rawImages.length - MAX_IMAGES);
  const keptImages = rawImages.slice(startIdx).map((img, i) => ({
    ...img,
    finalNum: i + 1,
    filename: `image_${i + 1}.png`,
  }));
  const keptByMarker = new Map(keptImages.map((img) => [img.markerIndex, img.finalNum]));

  const renderedTranscript = lines
    .join('\n\n')
    .replace(/\[\[IMAGE_SLOT_(\d+)\]\]/g, (_m, nStr) => {
      const num = keptByMarker.get(Number(nStr));
      return num ? `[Attached Image #${num}]` : '[Earlier Image omitted]';
    });

  return {
    transcript: renderedTranscript,
    images: keptImages.map(({ url, filename }) => ({ url, filename })),
  };
}

function buildToolProtocol(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0 || toolChoice === 'none') {
    return { active: false, promptBlock: '', declaredNames: new Set() };
  }
  const declaredNames = new Set();
  const entries = [];
  for (const tool of tools) {
    const fn = tool?.type === 'function' ? tool.function : tool?.function || tool;
    const name = typeof fn?.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    declaredNames.add(name);
    const desc = typeof fn.description === 'string' ? fn.description.trim().replace(/\s+/g, ' ').slice(0, 260) : '';
    const schema = summarizeSchema(fn.parameters);
    entries.push(`- ${name}${desc ? ': ' + desc : ''}\n  params: ${schema}`);
  }
  if (declaredNames.size === 0) {
    return { active: false, promptBlock: '', declaredNames };
  }

  let requiredToolHint = '';
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
    requiredToolHint = `\nYou MUST invoke the tool "${toolChoice.function.name}" for this turn.`;
  } else if (toolChoice === 'required') {
    requiredToolHint = '\nYou MUST call at least one tool from the list above.';
  }

  const promptBlock =
    `[SYSTEM HARNESS — EXTERNAL FUNCTION CALL DISPATCHER]\n` +
    `You are connected to a Windows desktop automation host harness (CapriCore / OpenClaw).\n` +
    `The host DOES have live desktop, mouse, keyboard, file, application, and screen permissions, and AUTOMATICALLY executes every tool call JSON you output, then feeds the [TOOL RESULT] back to you on the next turn.\n` +
    `NEVER say you lack access to any listed tool or cannot see/control the screen — outputting the JSON below IS how you invoke the tool.\n\n` +
    `[AVAILABLE TOOLS]\n${entries.join('\n')}\n\n` +
    `[TOOL CALL OUTPUT RULE]\n` +
    `- Whenever the user asks for an action or screen/file/system check that any tool above can perform, respond ONLY with ONE valid JSON object (no markdown fences, no commentary):\n` +
    `  {"tool_calls":[{"name":"<exact_tool_name>","arguments":{...}}]}\n` +
    `- Never invent tool names. Only reply in plain conversational text after required tool results arrive or when no tool is needed.${requiredToolHint}`;

  return { active: true, promptBlock, declaredNames };
}

function buildResponseFormatHint(responseFormat) {
  if (!responseFormat || typeof responseFormat !== 'object') return '';
  if (responseFormat.type === 'json_object') {
    return '\n\n[OUTPUT FORMAT REQUIREMENT]\nOutput ONLY a single valid raw JSON object. Do NOT wrap in ```json fences and do NOT add any extra prose before or after the JSON.';
  }
  if (responseFormat.type === 'json_schema' && responseFormat.json_schema) {
    const schemaText = JSON.stringify(responseFormat.json_schema.schema || responseFormat.json_schema).slice(0, 1800);
    return `\n\n[OUTPUT FORMAT REQUIREMENT]\nOutput ONLY raw valid JSON matching this JSON Schema (no markdown fences, no commentary):\n${schemaText}`;
  }
  return '';
}

function stripMarkdownFences(text) {
  let s = String(text || '').trim();
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(s);
  if (fenced) return fenced[1].trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return s;
}

function scanJsonCandidates(rawText) {
  const candidates = [];
  const texts = [stripMarkdownFences(rawText), String(rawText || '')];
  for (const s of texts) {
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '{') continue;
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let j = i; j < s.length; j++) {
        const ch = s[j];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const slice = s.slice(i, j + 1);
            try {
              const obj = JSON.parse(slice);
              if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                candidates.push({ obj, raw: slice });
              }
            } catch {}
            break;
          }
        }
      }
    }
  }
  return candidates;
}

function extractValidToolCalls(rawText, declaredNames) {
  if (!declaredNames || declaredNames.size === 0) return null;
  const canonicalByLower = new Map();
  for (const name of declaredNames) canonicalByLower.set(name.toLowerCase(), name);
  const resolveName = (n) => {
    if (typeof n !== 'string') return null;
    const t = n.trim();
    return declaredNames.has(t) ? t : canonicalByLower.get(t.toLowerCase()) || null;
  };

  for (const { obj } of scanJsonCandidates(rawText)) {
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
      const normalized = [];
      for (const call of obj.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        const fn = call.function && typeof call.function === 'object' ? call.function : call;
        const resolved = resolveName(fn.name);
        if (!resolved) continue;
        const rawArgs = fn.arguments ?? fn.args ?? {};
        let argStr = '{}';
        if (typeof rawArgs === 'string') {
          try {
            JSON.parse(rawArgs);
            argStr = rawArgs;
          } catch {
            argStr = JSON.stringify({ input: rawArgs });
          }
        } else if (rawArgs && typeof rawArgs === 'object') {
          argStr = JSON.stringify(rawArgs);
        }
        normalized.push({
          id: `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          type: 'function',
          function: {
            name: resolved,
            arguments: argStr,
          },
        });
      }
      if (normalized.length > 0) return normalized;
    }

    const singleName = resolveName(obj.name || obj.tool);
    if (singleName && (obj.arguments !== undefined || obj.args !== undefined || obj.parameters !== undefined)) {
      const rawArgs = obj.arguments ?? obj.args ?? obj.parameters ?? {};
      const argStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
      return [
        {
          id: `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          type: 'function',
          function: {
            name: singleName,
            arguments: argStr,
          },
        },
      ];
    }
  }
  return null;
}

function cleanJsonResponse(rawText) {
  const stripped = stripMarkdownFences(rawText);
  try {
    JSON.parse(stripped);
    return stripped;
  } catch {}
  for (const { raw } of scanJsonCandidates(rawText)) {
    return raw;
  }
  return stripped;
}

function selectEdgeVoice(text) {
  const sample = String(text || '');
  const idHints = /\b(?:yang|dan|aku|kamu|gua|lu|gw|apa|lagi|bisa|tidak|gak|nggak|iya|halo|selamat|tolong|coba|dong|sih|nih|itu|ini|sudah|udah|belum|kalau|kalo|mau|buat|untuk|dari|dengan|adalah|buka|ketik|klik|layar|bos)\b/i;
  return idHints.test(sample) ? 'id-ID-GadisNeural' : 'en-US-AriaNeural';
}

function prepareSpeechText(text, maxChars = 1350) {
  let s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' Kode sudah kutulis di layar. ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxChars) {
    const sub = s.slice(0, maxChars);
    const cut = Math.max(sub.lastIndexOf('. '), sub.lastIndexOf('! '), sub.lastIndexOf('? '));
    s = cut >= Math.floor(maxChars * 0.4) ? sub.slice(0, cut + 1).trim() : sub.trim();
  }
  return s;
}

function convertAudioToPcm24kMono(inputBuf) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', 'pipe:1'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const outChunks = [];
    const errChunks = [];
    ff.stdout.on('data', (c) => outChunks.push(c));
    ff.stderr.on('data', (c) => errChunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(Buffer.concat(errChunks).toString('utf8') || `ffmpeg exited ${code}`));
      }
      resolve(Buffer.concat(outChunks));
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(inputBuf);
  });
}

function buildWav24kMono16(pcmBuf) {
  const usableLen = pcmBuf.length - (pcmBuf.length % 2);
  const clampedLen = Math.min(usableLen, MAX_PCM_BYTES);
  const data = pcmBuf.subarray(0, clampedLen);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(24000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

let geminiQueue = Promise.resolve();
let lastGeminiCallEndedAt = 0;

function runSerializedGeminiCall(fn) {
  const next = geminiQueue.then(async () => {
    const gap = Date.now() - lastGeminiCallEndedAt;
    if (gap < 250) await new Promise((r) => setTimeout(r, 250 - gap));
    try {
      return await fn();
    } finally {
      lastGeminiCallEndedAt = Date.now();
    }
  });
  geminiQueue = next.catch(() => {});
  return next;
}

async function handleChatCompletions(req, res) {
  const body = await readJsonBody(req);
  const stream = body.stream === true;
  const responseFormat = body.response_format;
  const toolSpec = buildToolProtocol(body.tools, body.tool_choice);
  const { transcript, images } = extractMessagesAndImages(body.messages);
  const fullPrompt =
    (toolSpec.active ? toolSpec.promptBlock + '\n\n' : '') +
    transcript +
    buildResponseFormatHint(responseFormat) +
    (toolSpec.active
      ? '\n\n[INSTRUCTION]\nIf a tool is appropriate for the user request above, output ONLY {"tool_calls":[{"name":"...","arguments":{...}}]}. Otherwise respond normally.'
      : '\n\n[INSTRUCTION]\nRespond directly as the assistant following every constraint above.');

  const { upstreamResp, upstreamData, fetchError } = await runSerializedGeminiCall(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${GEMINI_URL}/api/gemini-complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(75000),
          body: JSON.stringify({
            prompt: fullPrompt,
            images,
            timeoutMs: 60000,
          }),
        });
        const d = await r.json().catch(() => null);
        if (r.ok && d?.ok) {
          return { upstreamResp: r, upstreamData: d, fetchError: '' };
        }
        logBridge('WARN', `gemini-complete attempt=${attempt} status=${r.status} err=${d?.error || 'unknown'}`);
        if (attempt === 0 && (r.status === 502 || r.status === 503)) {
          await new Promise((resDelay) => setTimeout(resDelay, 900));
          continue;
        }
        return { upstreamResp: r, upstreamData: d, fetchError: d?.error || `HTTP ${r.status}` };
      } catch (err) {
        const msg = err?.message || String(err);
        logBridge('WARN', `gemini-complete network attempt=${attempt} err=${msg}`);
        if (attempt === 0) {
          await new Promise((resDelay) => setTimeout(resDelay, 900));
          continue;
        }
        return { upstreamResp: null, upstreamData: null, fetchError: msg };
      }
    }
    return { upstreamResp: null, upstreamData: null, fetchError: 'retries_exhausted' };
  });
  if (!upstreamResp?.ok || !upstreamData?.ok) {
    const errMsg = upstreamData?.error || fetchError || `Gemini desktop bridge returned HTTP ${upstreamResp?.status || 502}`;
    logBridge('ERROR', `chat_completion_failed: ${errMsg}`);
    return sendJson(res, 502, {
      error: { message: errMsg, type: 'upstream_error', code: 'gemini_desktop_error' },
    });
  }

  let replyText = String(upstreamData.text || '').trim();
  const toolCalls = toolSpec.active ? extractValidToolCalls(replyText, toolSpec.declaredNames) : null;
  if (!toolCalls) {
    if (responseFormat && (responseFormat.type === 'json_object' || responseFormat.type === 'json_schema')) {
      replyText = cleanJsonResponse(replyText);
    } else {
      replyText = replyText.replace(/\s*\[cite:\s*\d+(?:,\s*\d+)*\]/gi, '').trim();
    }
  }

  const completionId = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 16);
  const created = Math.floor(Date.now() / 1000);
  const model = typeof body.model === 'string' && body.model ? body.model : MODEL_ID;

  if (!stream) {
    const message = toolCalls
      ? { role: 'assistant', content: null, tool_calls: toolCalls }
      : { role: 'assistant', content: replyText };
    return sendJson(res, 200, {
      id: completionId,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: toolCalls ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: Math.max(1, Math.ceil(fullPrompt.length / 4)),
        completion_tokens: Math.max(1, Math.ceil(replyText.length / 4)),
        total_tokens: Math.max(2, Math.ceil((fullPrompt.length + replyText.length) / 4)),
      },
    });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const writeSse = (deltaObj, finishReason = null) => {
    const chunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: deltaObj, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  if (toolCalls) {
    writeSse({ role: 'assistant', content: null }, null);
    toolCalls.forEach((tc, index) => {
      writeSse(
        {
          tool_calls: [
            {
              index,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            },
          ],
        },
        null,
      );
    });
    writeSse({}, 'tool_calls');
  } else {
    writeSse({ role: 'assistant', content: '' }, null);
    for (let i = 0; i < replyText.length; i += 160) {
      writeSse({ content: replyText.slice(i, i + 160) }, null);
    }
    writeSse({}, 'stop');
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleAudioSpeech(req, res) {
  const body = await readJsonBody(req, 1024 * 1024);
  const rawText = String(body.input ?? body.text ?? '').trim();
  const cleanText = prepareSpeechText(rawText);
  if (!cleanText) {
    return sendJson(res, 400, { error: { message: 'Missing speech text', type: 'invalid_request_error' } });
  }
  const edgeVoice = selectEdgeVoice(cleanText);
  const ttsResp = await fetch(`${TTS_URL}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      text: cleanText,
      voice: edgeVoice,
      rate: '+6%',
    }),
  });
  const ttsData = await ttsResp.json().catch(() => null);
  if (!ttsResp.ok || !ttsData?.success || !ttsData?.audio_base64) {
    return sendJson(res, 502, {
      error: { message: ttsData?.error || 'TTS sidecar failed', type: 'upstream_error' },
    });
  }
  const rawAudio = Buffer.from(ttsData.audio_base64, 'base64');
  const pcmBuf = await convertAudioToPcm24kMono(rawAudio);
  if (!pcmBuf.length) {
    return sendJson(res, 502, { error: { message: 'Empty PCM output', type: 'upstream_error' } });
  }
  const wavBuf = buildWav24kMono16(pcmBuf);
  res.writeHead(200, {
    'content-type': 'audio/wav',
    'x-sample-rate': '24000',
    'content-length': String(wavBuf.length),
    'cache-control': 'no-store',
  });
  res.end(wavBuf);
}

const server = createServer(async (req, res) => {
  const route = (req.url || '/').split('?')[0];
  try {
    if (req.method === 'GET' && route === '/health') {
      const status = await checkUpstreams();
      return sendJson(res, 200, { ok: true, model: MODEL_ID, ...status });
    }
    if (req.method === 'GET' && (route === '/v1/models' || route === '/models')) {
      return sendJson(res, 200, {
        object: 'list',
        data: [
          {
            id: MODEL_ID,
            object: 'model',
            created: 1735689600,
            owned_by: 'gemini-web-bridge',
          },
        ],
      });
    }
    if (req.method === 'POST' && (route === '/v1/chat/completions' || route === '/chat/completions')) {
      return await handleChatCompletions(req, res);
    }
    if (req.method === 'POST' && (route === '/v1/audio/speech' || route === '/audio/speech')) {
      return await handleAudioSpeech(req, res);
    }
    return sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    if (!res.headersSent) {
      return sendJson(res, status, { error: { message: err?.message || 'Internal bridge error' } });
    }
    try { res.destroy(); } catch {}
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[gemini_capri_bridge] listening on http://127.0.0.1:${PORT}/v1 (model=${MODEL_ID})`);
});
