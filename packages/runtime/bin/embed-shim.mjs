// SPDX-License-Identifier: GPL-3.0-only
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../src/host/paths.mjs';
import { settings } from '../src/config/settings.mjs';

const port = Number(process.env.CAPRI_OLLAMA_PORT) || settings.ollamaPort;
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid managed embed shim port.');

const EMBED_DIM = 1024;
const configuration = process.env.CAPRI_LLAMA_CONFIGURATION || '';
const started = new Date().toISOString();
const instance = randomUUID();
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function json(res, value, status = 200) {
  res.writeHead(status, jsonHeaders).end(JSON.stringify(value));
}

async function readJson(req) {
  const buffers = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw Object.assign(new Error('Request too large.'), { status: 413 });
    buffers.push(chunk);
  }
  if (!buffers.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw Object.assign(new Error('Invalid JSON request.'), { status: 400 });
}

function fnv1a(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Deterministic 1024-dim L2-normalized bag-of-ngrams embedding (zero native weights). */
function embedText(text) {
  const vec = new Float32Array(EMBED_DIM);
  const clean = String(text ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = clean.match(/[a-z0-9_]+/g) ?? [];
  const addFeature = (feat, weight) => {
    const h1 = fnv1a(feat, 2166136261);
    const h2 = fnv1a(feat, 0x811c9dc5 ^ 0x9e3779b9);
    const idx = h1 % EMBED_DIM;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    vec[idx] += sign * weight;
  };
  for (let i = 0; i < tokens.length; i++) {
    addFeature('w:' + tokens[i], 1.5);
    if (i + 1 < tokens.length) addFeature('b:' + tokens[i] + '_' + tokens[i + 1], 1.1);
  }
  for (let i = 0; i + 3 <= clean.length; i++) {
    addFeature('c:' + clean.slice(i, i + 3), 0.45);
  }
  let normSq = 0;
  for (let i = 0; i < EMBED_DIM; i++) normSq += vec[i] * vec[i];
  if (normSq === 0) {
    vec[0] = 1;
    normSq = 1;
  }
  const inv = 1 / Math.sqrt(normSq);
  const out = new Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) out[i] = Math.round(vec[i] * inv * 1e6) / 1e6;
  return out;
}

const modelTags = [
  {
    name: settings.embeddingModel,
    model: settings.embeddingModel,
    size: 0,
    digest: 'sha256:capri-embed-shim-v1',
    details: { family: 'capri-embed-shim', parameter_size: '0B', quantization_level: 'Q0' },
  },
];

const server = createServer(async (req, res) => {
  if (
    !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '') ||
    (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)
  )
    return json(res, { error: 'Local inference is restricted to Capri.' }, 403);
  const method = req.method;
  const route = (req.url || '/').split('?')[0];
  try {
    if (method === 'GET') {
      if (route === '/api/version')
        return json(res, { version: settings.llamaVersion, engine: 'llama.cpp', started, instance, configuration });
      if (route === '/api/tags') return json(res, { models: modelTags });
      if (route === '/api/ps')
        return json(res, {
          models: [{ name: settings.embeddingModel, model: settings.embeddingModel, size: 0, size_vram: 0 }],
        });
      if (route === '/v1/models')
        return json(res, {
          object: 'list',
          data: [{ id: settings.embeddingModel, object: 'model', owned_by: 'capri' }],
        });
      return json(res, { error: 'Unknown local endpoint.' }, 404);
    }
    if (!['POST', 'DELETE'].includes(method))
      return json(res, { error: 'Unknown local endpoint.' }, 404);
    const input = await readJson(req);
    if (route === '/api/show')
      return json(res, {
        modelfile: '',
        parameters: '',
        template: '',
        details: { family: 'capri-embed-shim' },
        model_info: { 'general.architecture': 'bert', 'bert.embedding_length': EMBED_DIM },
      });
    if (route === '/api/create') return json(res, { status: 'success' });
    if (route === '/api/pull' && method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ status: 'success' }) + '\n');
      return;
    }
    if (route === '/api/delete' && method === 'DELETE') return json(res, {});
    if (route === '/api/generate' && method === 'POST')
      return json(res, { model: input.model || settings.model, done: true, done_reason: 'unload' });
    if (['/api/embed', '/api/embeddings', '/v1/embeddings'].includes(route)) {
      const rawSource = input.input ?? input.prompt ?? '';
      const texts = Array.isArray(rawSource) ? rawSource.map((t) => String(t ?? '')) : [String(rawSource)];
      const vectors = texts.map(embedText);
      if (route === '/v1/embeddings')
        return json(res, {
          object: 'list',
          model: input.model || settings.embeddingModel,
          data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      if (route === '/api/embeddings') return json(res, { embedding: vectors[0] });
      return json(res, {
        model: input.model || settings.embeddingModel,
        embeddings: vectors,
        prompt_eval_count: 1,
      });
    }
    return json(res, { error: 'Unknown local inference endpoint.' }, 404);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return json(res, { error: error?.message || 'Internal shim error' }, status);
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

let closing;
const stopFile = path.join(paths.data, 'run/llama.stop');
const close = () => {
  if (closing) return closing;
  clearInterval(stopTimer);
  server.close();
  server.closeAllConnections();
  process.exitCode = 0;
  closing = Promise.resolve();
  return closing;
};
const stopTimer = setInterval(() => {
  if (existsSync(stopFile)) void close();
}, 200);
process.on('SIGTERM', close);
process.on('SIGINT', close);
