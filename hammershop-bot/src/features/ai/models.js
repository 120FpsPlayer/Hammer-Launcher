'use strict';

/**
 * The models the AI assistant uses, one by one: which of them is limited or unavailable right now, and how much each was
 * used today (for /asystent status). The free plans (Groq) limit every model separately – per minute and per day – so
 * when one model's limit runs out the next one in the chain takes the same request (src/features/ai/openai.js).
 *
 *   unavailable – the provider doesn't know the model, retired it or blocks it for the account: skipped until the bot is
 *                 restarted (one console warning)
 *   limitedUntil – a 429: skipped until the provider says the limit frees up
 *   usage       – requests and tokens per model today (the day changes at midnight, Polish time)
 *
 * In memory only: a restart starts from scratch, like the provider's own minute limits.
 */

const state = new Map(); // model → { unavailable: string | null, limitedUntil: ms }
let day = null;
const used = new Map(); // model → { requests, tokens }

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' }); // YYYY-MM-DD

function entry(model) {
  if (!state.has(model)) state.set(model, { unavailable: null, limitedUntil: 0 });
  return state.get(model);
}

const isUnavailable = (model) => Boolean(state.get(model)?.unavailable);
/** Until when the model is limited (ms) – 0 when it isn't. */
const limitedUntil = (model, now = Date.now()) => {
  const until = state.get(model)?.limitedUntil ?? 0;
  return until > now ? until : 0;
};
const isReady = (model, now = Date.now()) => !isUnavailable(model) && !limitedUntil(model, now);

/** The provider rejected the model (404, retired, blocked) – skip it until a restart, say so once. */
function markUnavailable(model, reason = '') {
  const e = entry(model);
  if (e.unavailable) return;
  e.unavailable = String(reason || 'niedostępny').slice(0, 200);
  console.warn(`🤖 Asystent AI: model „${model}” nie działa na tym koncie (${e.unavailable}) – pomijam go do ponownego uruchomienia bota. Listę modeli zmienisz w .env (AI_MODEL).`);
}

/** A 429: the model is skipped until `until`. */
function markLimited(model, until) {
  const e = entry(model);
  e.limitedUntil = Math.max(e.limitedUntil, until);
}

function rollDay() {
  const d = today();
  if (d !== day) {
    day = d;
    used.clear();
  }
}

/** One answer from `model` – its usage block (input/prompt and output/completion tokens) is added to today's total. */
function noteUsage(model, usage = {}) {
  if (!model) return;
  rollDay();
  const u = used.get(model) ?? { requests: 0, tokens: 0 };
  const tokens = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((sum, k) => sum + (Number(usage?.[k]) || 0), 0);
  used.set(model, { requests: u.requests + 1, tokens: u.tokens + tokens });
}

function usageOf(model) {
  rollDay();
  return used.get(model) ?? { requests: 0, tokens: 0 };
}

/** The chain as /asystent status shows it → [{ model, state: 'ok' | 'limited' | 'unavailable', until, reason, requests, tokens }]. */
function describe(chain, now = Date.now()) {
  return chain.map((model) => {
    const until = limitedUntil(model, now);
    const status = isUnavailable(model) ? 'unavailable' : until ? 'limited' : 'ok';
    return { model, state: status, until: until || null, reason: state.get(model)?.unavailable ?? null, ...usageOf(model) };
  });
}

/** Tests (and a fresh start). */
function reset() {
  state.clear();
  used.clear();
  day = null;
}

module.exports = { isReady, isUnavailable, limitedUntil, markUnavailable, markLimited, noteUsage, usageOf, describe, reset };
