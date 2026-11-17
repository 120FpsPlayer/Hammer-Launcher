'use strict';

// „Gra teraz” on the Discord server: while a game runs the launcher tells the website so, with a random id per game
// session and nothing else; an FPS test is not a game; the last game ending says so at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPlaying, EVERY } = require('../src/main/playing');
const { createShopApi } = require('../src/main/shopapi');

function setup({ putPlaying } = {}) {
  const games = new EventEmitter();
  const calls = [];
  const shop = { putPlaying: putPlaying ?? (async (session, on) => calls.push([session, on])) };
  const timers = { list: [], setInterval(fn, ms) { const t = { fn, ms, cleared: false }; this.list.push(t); return t; }, clearInterval(t) { if (t) t.cleared = true; } };
  let n = 0;
  const playing = createPlaying({ games, shop, timers, newId: () => `sesja-${String(++n).padStart(12, '0')}` });
  const state = (instanceId, s, extra = {}) => games.emit('state', { instanceId, state: s, ...extra });
  return { games, calls, timers, playing, state };
}

test('a game starts → the website hears „a game runs here” at once and every two minutes; it ends → „it ended”', () => {
  const { calls, timers, playing, state } = setup();
  state('hammer', 'starting');
  state('hammer', 'running');
  assert.deepEqual(calls, [['sesja-000000000001', true]], 'once at the start – not again for running');
  assert.equal(timers.list.length, 1);
  assert.equal(timers.list[0].ms, EVERY);
  assert.ok(EVERY < 5 * 60_000, 'well within the five minutes the website keeps it');
  timers.list[0].fn();
  timers.list[0].fn();
  assert.deepEqual(calls.at(-1), ['sesja-000000000001', true]);
  state('hammer', 'exited');
  assert.deepEqual(calls.at(-1), ['sesja-000000000001', false]);
  assert.equal(timers.list[0].cleared, true);
  assert.equal(playing.active(), false);
  // The next game is a new session with a new id – nothing links the two.
  state('hammer', 'starting');
  assert.deepEqual(calls.at(-1), ['sesja-000000000002', true]);
});

test('two games at once are one launcher; only the last one ending ends the session; a crash ends it too', () => {
  const { calls, state } = setup();
  state('a', 'starting');
  state('b', 'starting');
  state('a', 'exited');
  assert.equal(calls.filter(([, on]) => on === false).length, 0, 'b still runs');
  state('b', 'crashed');
  assert.deepEqual(calls, [['sesja-000000000001', true], ['sesja-000000000001', false]]);
});

test('an FPS test is not a game; a website that is offline never throws into the launcher', async () => {
  const { calls, state } = setup();
  state('a', 'starting', { benchmark: true });
  state('a', 'exited', { benchmark: true });
  assert.deepEqual(calls, []);
  const offline = setup({ putPlaying: async () => { throw new Error('offline'); } });
  assert.doesNotThrow(() => offline.state('a', 'starting'));
  assert.doesNotThrow(() => offline.state('a', 'exited'));
  await new Promise((r) => setImmediate(r)); // the rejected calls are caught, not unhandled
});

test('the request: PUT /api/launcher/playing with only the session id and true/false – no code, no account', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const shop = createShopApi({ config: { website: 'https://hammerclient.com' }, fetchFn, version: '2.11.3' });
  assert.equal(await shop.putPlaying('abcdef0123456789abcd', true), true);
  assert.equal(seen[0].url, 'https://hammerclient.com/api/launcher/playing');
  assert.equal(seen[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(seen[0].init.body), { session: 'abcdef0123456789abcd', playing: true });
  assert.equal(seen[0].init.headers.authorization, undefined);
  await assert.rejects(createShopApi({ config: { website: 'https://hammerclient.com' }, fetchFn: async () => new Response('<html>', { status: 502 }), version: '2.11.3' }).putPlaying('abcdef0123456789abcd', false), { offline: true });
});
