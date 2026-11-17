'use strict';

/**
 * „Gra teraz” – the stat channel on the Discord server counts the games running through the launcher right now. While
 * a game runs (any instance, also singleplayer and vanilla) the launcher tells the website so every two minutes, and
 * once the last game has ended it says that too. All it sends is a random id made for that one game session: no
 * account, no nick – the website keeps it for five minutes, in memory (hammershop-bot/src/web/launcher.js).
 * An FPS test is not a game session. Nothing here ever waits on the network or shows an error: a website that is
 * offline just means the channel shows a smaller number.
 */

const crypto = require('node:crypto');

const EVERY = 2 * 60_000; // the website forgets a game after 5 minutes without news

function createPlaying({ games, shop, every = EVERY, timers = { setInterval, clearInterval }, newId = () => crypto.randomUUID() }) {
  const playing = new Set(); // instance ids of the real games running now (FPS tests left out)
  let session = null;
  let timer = null;

  const tell = (id, on) => Promise.resolve(shop.putPlaying?.(id, on)).catch(() => null); // offline: the next beat tries again

  function start() {
    if (session) return;
    session = newId();
    tell(session, true);
    timer = timers.setInterval(() => tell(session, true), every);
    timer?.unref?.();
  }

  function stop() {
    if (!session) return;
    timers.clearInterval(timer);
    tell(session, false);
    session = null;
    timer = null;
  }

  games.on('state', (e) => {
    if (!e?.instanceId || e.benchmark) return;
    if (e.state === 'starting' || e.state === 'running') playing.add(e.instanceId);
    else if (e.state === 'exited' || e.state === 'crashed') playing.delete(e.instanceId);
    else return;
    if (playing.size) start();
    else stop();
  });

  return { stop, active: () => Boolean(session), session: () => session };
}

module.exports = { createPlaying, EVERY };
