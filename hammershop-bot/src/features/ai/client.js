'use strict';

/**
 * Which AI the assistant in tickets talks to (src/features/aiassistant.js) – chosen in .env:
 *
 *   AI_PROVIDER = auto (default) | groq | claude | openai
 *     auto    Groq when GROQ_API_KEY is set, else Claude when ANTHROPIC_API_KEY is set, else none (the no-AI mode:
 *             prizes are claimed with buttons, „człowiek” still calls the team)
 *     groq    free – GROQ_API_KEY from console.groq.com; a chain of free models (DEFAULT_CHAINS.groq) unless AI_MODEL
 *     claude  paid – ANTHROPIC_API_KEY, the official Anthropic SDK; model claude-opus-5-5 unless AI_MODEL (one model)
 *     openai  any OpenAI-compatible API (e.g. Gemini) – AI_BASE_URL + AI_API_KEY + AI_MODEL
 *
 *   AI_MODEL may be a comma-separated list: the free plans limit every model separately, so when one model's limit
 *   runs out the next one answers (src/features/ai/models.js, ./openai.js). Claude uses the first entry only.
 *
 * Every provider is used with the same Anthropic-shaped request and response: Claude through its SDK, Groq and the
 * OpenAI-compatible ones through the adapter in ./openai.js (plain fetch). Tests put a fake client here with setClient().
 */

require('../../env'); // .env is read before the keys are looked at
const openai = require('./openai');

const PROVIDERS = ['groq', 'claude', 'openai'];
/** Groq's free chat models, best first (names change on Groq – a model it no longer knows is skipped by itself). */
const DEFAULT_CHAINS = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3-32b'],
  claude: ['claude-opus-5-5'],
};
const DEFAULT_MODELS = { groq: DEFAULT_CHAINS.groq[0], claude: DEFAULT_CHAINS.claude[0] };
const GROQ_URL = 'https://api.groq.com/openai/v1';
/** The .env key of each provider – for messages about a rejected key. */
const KEY_VARS = { groq: 'GROQ_API_KEY', claude: 'ANTHROPIC_API_KEY', openai: 'AI_API_KEY' };

const str = (name) => (process.env[name] || '').trim();

let injected = null;
let injectedProvider = 'claude';
let real = null;
let realKey = null;
let sdkModule; // undefined: not tried yet · null: the package is missing

/** The @anthropic-ai/sdk package – null when it isn't installed (npm install not run after the update). */
function sdk() {
  if (sdkModule !== undefined) return sdkModule;
  try {
    sdkModule = require('@anthropic-ai/sdk');
  } catch {
    sdkModule = null;
  }
  return sdkModule;
}

/** The Anthropic class – its static error classes (RateLimitError, …) are what the assistant catches for Claude. */
const Anthropic = () => {
  const mod = sdk();
  return mod ? mod.Anthropic ?? mod.default ?? mod : null;
};

/** Tests: a fake client (null = back to the real ones); provider: what the fake stands for. */
function setClient(fake, { provider = 'claude' } = {}) {
  injected = fake ?? null;
  injectedProvider = provider;
}

const wanted = () => str('AI_PROVIDER').toLowerCase() || 'auto';

/** 'groq' | 'claude' | 'openai' | null (no AI). */
function provider() {
  if (injected) return injectedProvider;
  const want = wanted();
  if (PROVIDERS.includes(want)) return want;
  if (want !== 'auto') return null;
  if (str('GROQ_API_KEY')) return 'groq';
  if (str('ANTHROPIC_API_KEY')) return 'claude';
  return null;
}

/**
 * Models that cannot hold a conversation – safety classifiers (Prompt Guard, Llama Guard), speech-to-text, text-to-speech,
 * embeddings. Set in AI_MODEL by mistake, they would only fail; the default chat model is used instead (said once).
 */
const NOT_CHAT = /(prompt-guard|llama-guard|safeguard|whisper|distil-whisper|\btts\b|-tts|playai|orpheus|embed|moderation|rerank)/i;
let warnedModel = null;

/**
 * The models to use, in order – AI_MODEL (a comma-separated list) or the provider's default chain. Models that can't
 * chat are dropped from the list (said once); when nothing is left, the default chain is used.
 */
function models() {
  const p = provider();
  const raw = str('AI_MODEL');
  const listed = [...new Set(raw.split(',').map((m) => m.trim()).filter(Boolean))];
  const dropped = listed.filter((m) => NOT_CHAT.test(m));
  const chat = listed.filter((m) => !NOT_CHAT.test(m));
  const fallback = DEFAULT_CHAINS[p] ?? [];
  const chain = chat.length ? chat : fallback;
  if (dropped.length && warnedModel !== raw) {
    warnedModel = raw;
    const names = dropped.map((m) => `„${m}”`).join(', ');
    console.warn(
      `🤖 Asystent AI: ${names} (AI_MODEL w .env) to ${dropped.length > 1 ? 'modele, które nie prowadzą' : 'model, który nie prowadzi'} rozmów (np. filtr bezpieczeństwa albo mowa) – ` +
        `${chat.length ? 'pomijam' : `używam domyślnego „${fallback[0] ?? '—'}”${fallback.length > 1 ? ` (i kolejnych: ${fallback.slice(1).join(', ')})` : ''}`}. ` +
        'Usuń je z AI_MODEL albo wpisz modele czatu z https://console.groq.com/docs/models.',
    );
  }
  return p === 'claude' ? chain.slice(0, 1) : chain;
}

/** The first model of the chain – the one normally answering. */
const model = () => models()[0] ?? '';

/** Groq and the other OpenAI-compatible providers: small free limits – a compact prompt, fewer tools, a short history. */
const compact = () => {
  const p = provider();
  return Boolean(p) && p !== 'claude';
};

/** Why there is no AI – null when it is configured. */
function problem() {
  if (injected) return null;
  const want = wanted();
  if (want !== 'auto' && !PROVIDERS.includes(want)) return 'bad-provider';
  const p = provider();
  if (!p) return 'no-key';
  if (p === 'groq' && !str('GROQ_API_KEY')) return 'no-groq-key';
  if (p === 'claude' && !str('ANTHROPIC_API_KEY')) return 'no-claude-key';
  if (p === 'claude' && !Anthropic()) return 'no-sdk';
  if (p === 'openai' && !(str('AI_BASE_URL') && str('AI_API_KEY') && models().length)) return 'openai-incomplete';
  return null;
}

const configured = () => !problem();

/** The client – null when not configured. Claude: one SDK client (it retries 429/5xx itself); the others: the adapter. */
function client() {
  if (injected) return injected;
  if (problem()) return null;
  const p = provider();
  if (p === 'claude') {
    if (!real || realKey !== str('ANTHROPIC_API_KEY')) {
      const A = Anthropic();
      realKey = str('ANTHROPIC_API_KEY');
      real = new A({ apiKey: realKey, maxRetries: 2, timeout: 120_000 }); // timeout in milliseconds
    }
    return real;
  }
  if (p === 'groq') return openai.createClient({ provider: 'groq', baseURL: GROQ_URL, apiKey: str('GROQ_API_KEY'), models: models() });
  return openai.createClient({ provider: 'openai', baseURL: str('AI_BASE_URL'), apiKey: str('AI_API_KEY'), models: models() });
}

/** "Groq", "Claude (Anthropic)", "zgodne z OpenAI (generativelanguage.googleapis.com)" – for /asystent status and logs. */
function label(p = provider()) {
  if (p === 'groq') return 'Groq (darmowy)';
  if (p === 'claude') return 'Claude (Anthropic)';
  if (p === 'openai') {
    let host = str('AI_BASE_URL');
    try {
      host = new URL(host).host;
    } catch {
      /* not a URL – shown as written */
    }
    return `zgodne z OpenAI${host ? ` (${host})` : ''}`;
  }
  return 'brak';
}

/**
 * How much of the ticket goes into one request (messages kept, characters per message, the form, the knowledge file's
 * matches, output tokens). The free providers count tokens per minute and per day, so they get the short version;
 * Claude reads its long prefix from the cache.
 *
 * maxTokens is a ceiling, not a target – the prompt keeps answers short. It must leave room for the hidden reasoning:
 * gpt-oss (the first free model) and Gemini 2.5 think before they answer and pay for it out of the same max_tokens, and
 * Polish costs about one token per 2–3 characters. 500 was often used up halfway through a sentence (finish_reason
 * "length"); 1500 fits low-effort reasoning plus a long answer. formChars fits a whole ticket form – it is the first
 * question now (the longest, „Zgłoś błąd”, is up to ~1,500 characters).
 */
const budget = () =>
  compact()
    ? { history: 6, messageChars: 400, formChars: 1600, knowledgeChars: 1200, maxTokens: 1500 }
    : { history: 30, messageChars: 1500, formChars: 3000, knowledgeChars: 4000, maxTokens: 8000 };

module.exports = { DEFAULT_MODELS, DEFAULT_CHAINS, KEY_VARS, GROQ_URL, NOT_CHAT, provider, model, models, compact, client, configured, problem, label, budget, setClient, Anthropic };
