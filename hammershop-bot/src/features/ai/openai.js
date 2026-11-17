'use strict';

/**
 * Groq and other OpenAI-compatible chat APIs (Gemini, …) for the AI assistant – plain fetch, no extra package.
 *
 * The adapter takes the Anthropic-shaped request aiassistant.js builds and gives back an Anthropic-shaped message, so the
 * assistant's tool loop is the same for every provider:
 *   request:  system (top-level and mid-conversation role:'system') → system messages · assistant tool_use blocks →
 *             tool_calls (arguments: a JSON string) · user tool_result blocks → role:'tool' messages right after ·
 *             thinking blocks skipped · tools → { type:'function', function:{ name, description, parameters } } ·
 *             everything only Claude knows (cache_control, betas, fallbacks, output_config, strict) left out
 *   response: content → a text block · tool_calls → tool_use blocks (broken JSON arguments are marked invalid_json, so
 *             the loop answers with an error tool_result and the model tries again) · finish_reason stop → end_turn,
 *             tool_calls → tool_use, length → max_tokens, content_filter → refusal
 * Errors are ProviderError with a kind the assistant acts on: 'rate-limit' (with retryAfterMs) · 'auth' · 'model' ·
 * 'server' · 'network' · 'timeout' · 'bad-request' · 'too-large' · 'tool-failed' (the model wrote a broken tool call) ·
 * 'bad-response' (an answer that doesn't follow the format).
 *
 * Model rotation: the client gets a chain of models (AI_MODEL, or the provider's default list). A model the provider
 * doesn't know (404, retired, blocked) is marked unavailable and skipped; a 429 marks the model limited until its reset
 * and the same request goes to the next model at once (./models.js keeps that state). Only when no model is left the
 * error reaches the assistant – which then takes a break. A short per-minute limit (≤ SHORT_WAIT) is waited out once.
 */

const crypto = require('node:crypto');
const models = require('./models');

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 1500; // a hard cap – reasoning + answer; the assistant asks for exactly this on the free providers
const MAX_RETRY_AFTER_MS = 3_600_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MIN_WAIT_MS = 1000; // a limit "free again in 0 ms" is still a limit – never retried in a busy loop
const CORRECTION = 'Poprzednie wywołanie narzędzia było błędne. Używaj tylko narzędzi z listy, z argumentami jako jeden poprawny obiekt JSON – albo odpowiedz zwykłym tekstem.';

class ProviderError extends Error {
  constructor(kind, message, { status = null, code = null, retryAfterMs = null, provider = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.provider = provider;
  }
}

/** Tests put their own fetch here (nothing leaves the computer); the bot uses the real one. */
let fetcher = null;
const setFetch = (fn) => (fetcher = fn ?? null);
let retryDelayMs = 1000;
const setRetryDelay = (ms) => (retryDelayMs = ms);
// A per-minute limit that frees up within seconds is waited out once instead of starting a break (and a staff ping).
let shortWaitMs = 20_000;
const setShortWait = (ms) => (shortWaitMs = ms);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Text of a string or a list of Anthropic content blocks. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n');
}

/** The JSON schema without what only Claude's strict mode wants (some OpenAI-compatible servers reject it). */
function plainSchema(schema = {}) {
  const out = { type: schema.type ?? 'object', properties: {} };
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const rest = { ...value };
    delete rest.additionalProperties;
    out.properties[key] = rest;
  }
  if (schema.required?.length) out.required = [...schema.required];
  return out;
}

const EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

/** Anthropic-shaped request → the chat/completions body. */
function toChat(params) {
  const messages = [];
  const toolNames = new Map();
  const system = textOf(params.system).trim();
  if (system) messages.push({ role: 'system', content: system });
  for (const m of params.messages ?? []) {
    if (m.role === 'system') {
      const text = textOf(m.content).trim();
      if (text) messages.push({ role: 'system', content: text });
      continue;
    }
    if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        if (m.content.trim()) messages.push({ role: 'assistant', content: m.content });
        continue;
      }
      const text = textOf(m.content).trim();
      const calls = (m.content ?? [])
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          toolNames.set(b.id, b.name);
          return { id: b.id, type: 'function', function: { name: b.name, arguments: b.invalid_json !== undefined ? '{}' : JSON.stringify(b.input ?? {}) } };
        });
      if (!text && !calls.length) continue; // only thinking / fallback blocks
      messages.push({ role: 'assistant', content: text || null, ...(calls.length && { tool_calls: calls }) });
      continue;
    }
    if (typeof m.content === 'string') {
      messages.push({ role: 'user', content: m.content });
      continue;
    }
    for (const b of m.content ?? []) {
      if (b.type !== 'tool_result') continue;
      const name = toolNames.get(b.tool_use_id);
      messages.push({ role: 'tool', tool_call_id: b.tool_use_id, ...(name && { name }), content: textOf(b.content) || (b.is_error ? 'Błąd' : 'OK') });
    }
    const text = textOf(m.content).trim();
    if (text) messages.push({ role: 'user', content: text });
  }
  const model = params.model;
  const body = { model, messages, max_tokens: Math.min(params.max_tokens ?? MAX_OUTPUT, MAX_OUTPUT) };
  if (params.tools?.length) {
    body.tools = params.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: plainSchema(t.input_schema) } }));
    body.tool_choice = 'auto';
  }
  // gpt-oss reasons before it answers – "low" keeps that short (and inside the free token limits).
  if (/gpt-oss/i.test(model ?? '')) body.reasoning_effort = EFFORT[params.output_config?.effort] ?? 'low';
  return body;
}

/** Tool arguments from the model – free models sometimes send broken JSON. → { ok, value } */
function parseArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, value: raw };
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** The chat/completions response → an Anthropic-shaped message. */
function fromChat(json, model) {
  const choice = json.choices[0];
  const msg = choice?.message ?? {};
  const raw = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => p?.text ?? '').join('') : '';
  // Models that write their reasoning into the answer (qwen): finished <think> blocks, an answer whose opening <think>
  // was lost, and reasoning cut off by max_tokens before its </think> – that one never reaches a ticket either.
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[\s\S]*<\/think>/, '')
    .replace(/<think>[\s\S]*$/, '')
    .trim();
  if (msg.tool_calls != null && (!Array.isArray(msg.tool_calls) || msg.tool_calls.some((c) => !c || typeof c !== 'object'))) {
    throw new ProviderError('bad-response', 'nieprawidłowe tool_calls w odpowiedzi');
  }
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const call of msg.tool_calls ?? []) {
    if (call?.type && call.type !== 'function') continue;
    const args = parseArguments(call.function?.arguments);
    content.push({
      type: 'tool_use',
      id: call.id || `call_${crypto.randomBytes(6).toString('hex')}`,
      name: String(call.function?.name ?? ''),
      input: args.ok ? args.value : {},
      ...(!args.ok && { invalid_json: String(call.function?.arguments ?? '').slice(0, 500) }),
    });
  }
  const finish = choice?.finish_reason;
  const stopReason =
    finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  return {
    id: json.id ?? `chat_${crypto.randomBytes(6).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: model ?? json.model, // the name from the chain – today's counters are kept per chain entry
    content,
    stop_reason: stopReason,
    stop_details: null,
    usage: { input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0 },
  };
}

/** "2m59.56s", "7.66s", "1h2m", "350ms", "12" (seconds) → milliseconds (null when unreadable). */
function parseDuration(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  let total = 0;
  let matched = '';
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
    matched += m[0];
  }
  return matched === s ? Math.round(total) : null;
}

/** How long to wait after a 429: retry-after, or the reset of the limit that ran out. Capped at an hour. */
function retryAfter(headers) {
  const get = (name) => headers?.get?.(name) ?? null;
  let ms = parseDuration(get('retry-after'));
  if (ms === null) {
    const date = Date.parse(get('retry-after') ?? '');
    if (Number.isFinite(date)) ms = date - Date.now();
  }
  if (ms === null) {
    const resets = [];
    if (get('x-ratelimit-remaining-requests') === '0') resets.push(parseDuration(get('x-ratelimit-reset-requests')));
    if (get('x-ratelimit-remaining-tokens') === '0') resets.push(parseDuration(get('x-ratelimit-reset-tokens')));
    if (!resets.length) resets.push(parseDuration(get('x-ratelimit-reset-requests')), parseDuration(get('x-ratelimit-reset-tokens')));
    const known = resets.filter((x) => x !== null);
    if (known.length) ms = Math.max(...known);
  }
  return Math.min(Math.max(ms ?? DEFAULT_RETRY_AFTER_MS, 0), MAX_RETRY_AFTER_MS);
}

function toError(res, json, provider) {
  const body = Array.isArray(json) ? json[0] : json; // Gemini wraps its error in a list
  const code = body?.error?.code ?? body?.error?.type ?? null;
  const message = String(body?.error?.message ?? `HTTP ${res.status}`).slice(0, 300);
  const meta = { status: res.status, code, provider };
  if (res.status === 429) return new ProviderError('rate-limit', message, { ...meta, retryAfterMs: retryAfter(res.headers) });
  // A 403 about the model (blocked for the organisation, terms not accepted) is not a bad key.
  if (res.status === 403 && /model/i.test(`${code ?? ''} ${message}`)) return new ProviderError('model', message, meta);
  if (res.status === 401 || res.status === 403) return new ProviderError('auth', message, meta);
  if (res.status === 404 || code === 'model_not_found' || code === 'model_decommissioned') return new ProviderError('model', message, meta);
  if (res.status === 413 || code === 'request_too_large') return new ProviderError('too-large', message, meta); // over this model's per-minute size
  if (res.status >= 500) return new ProviderError('server', message, meta);
  if (code === 'tool_use_failed') return new ProviderError('tool-failed', message, meta); // Groq: the model wrote a broken tool call
  return new ProviderError('bad-request', message, meta);
}

/**
 * Nothing left in the chain: a rate-limit error (until the first model frees up – also when a model was limited only
 * for a moment during this request) or a model error (none of them works on this account).
 */
function exhausted(chain, provider, limitedNow, now = Date.now()) {
  const resets = chain.map((m) => models.limitedUntil(m, now)).filter(Boolean);
  if (resets.length || limitedNow.size) {
    const wait = resets.length ? Math.min(...resets) - now : MIN_WAIT_MS;
    return new ProviderError('rate-limit', `wszystkie modele mają wyczerpany limit (${chain.join(', ')})`, { provider, retryAfterMs: Math.max(MIN_WAIT_MS, wait), code: 'all_models_limited' });
  }
  return new ProviderError('model', `żaden model nie działa na tym koncie (${chain.join(', ')})`, { provider, code: 'no_model_available' });
}

/**
 * A client with the same surface as the Anthropic SDK's beta.messages.create (only what the assistant uses).
 * provider: 'groq' | 'openai' – for messages; baseURL without /chat/completions; models: the chain to rotate through.
 */
function createClient({ provider, baseURL, apiKey, models: chain = [] }) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/chat/completions`;

  /** One model, one request – with one more try after a network error or a 5xx. */
  async function send(body) {
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await (fetcher ?? globalThis.fetch)(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        if (!timeout && attempt === 0) {
          await sleep(retryDelayMs);
          continue;
        }
        throw new ProviderError(timeout ? 'timeout' : 'network', timeout ? `brak odpowiedzi w ${TIMEOUT_MS / 1000} s` : `brak połączenia (${err?.message ?? err})`, { provider });
      }
      const json = await res.json().catch(() => null);
      if (res.ok) {
        if (!Array.isArray(json?.choices) || !json.choices.length) throw new ProviderError('server', 'pusta odpowiedź', { status: res.status, provider });
        return fromChat(json, body.model);
      }
      const err = toError(res, json, provider);
      if (err.kind === 'server' && attempt === 0) {
        await sleep(retryDelayMs);
        continue;
      }
      throw err;
    }
  }

  async function create(params) {
    const list = chain.length ? chain : [params.model].filter(Boolean);
    let skipped = null; // a request this model can't take (400/413, a broken tool call twice) – the next one may
    let waited = false;
    const limitedNow = new Set(); // models that answered 429 during this request
    for (;;) {
      for (const model of list) {
        if (!models.isReady(model)) continue;
        let body = toChat({ ...params, model });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await send(body);
          } catch (err) {
            if (!(err instanceof ProviderError)) throw err;
            if ((err.kind === 'tool-failed' || err.kind === 'bad-response') && attempt === 0) {
              body = { ...body, messages: [...body.messages, { role: 'system', content: CORRECTION }] }; // once more, corrected
              continue;
            }
            if (err.kind === 'model') models.markUnavailable(model, err.message);
            else if (err.kind === 'rate-limit') {
              limitedNow.add(model);
              models.markLimited(model, Date.now() + Math.max(MIN_WAIT_MS, err.retryAfterMs ?? 0));
            } else if (['bad-request', 'too-large', 'tool-failed', 'bad-response'].includes(err.kind)) skipped ??= err;
            else throw err; // a bad key, the network, the provider down – the same for every model
            break;
          }
        }
      }
      const now = Date.now();
      const resets = list.map((m) => models.limitedUntil(m, now)).filter(Boolean);
      const soonest = resets.length ? Math.min(...resets) - now : Infinity;
      if (!waited && soonest <= shortWaitMs && !list.some((m) => models.isReady(m, now))) {
        waited = true; // every model is out, but one frees up in a few seconds – wait for it once
        await sleep(soonest);
        continue;
      }
      if (skipped && !resets.length && !limitedNow.size) throw skipped;
      throw exhausted(list, provider, limitedNow);
    }
  }
  return { provider, url, models: chain, beta: { messages: { create } } };
}

module.exports = { createClient, ProviderError, toChat, fromChat, parseArguments, parseDuration, retryAfter, setFetch, setRetryDelay, setShortWait, MAX_OUTPUT };
