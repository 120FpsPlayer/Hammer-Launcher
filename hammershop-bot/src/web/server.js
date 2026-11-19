'use strict';

/**
 * The store website, served by the bot (src/features/website.js starts it). The page (web/public/index.html) talks
 * to this API under /api/shop/:
 *
 *   GET  store            products (the bot's shop), what's switched on, the Discord invite, the currency
 *   GET  session          the signed-in Discord user (signing in is all it takes to buy – there is no access fee)
 *   GET  auth/start       → Discord sign-in;  auth/callback  ← back from Discord (sets the session cookie; the bot adds
 *                         the user to the HammerShop server with the Member role – onLogin)
 *   POST logout
 *   POST checkout         { kind: 'products', requestId, items: [{ id, quantity }] } → { url } (Stripe Checkout)
 *   POST verify           { sessionId } – after Stripe sends the buyer back: is it paid?
 *   GET  orders           the user's website orders (newest first)
 *   POST stripe/webhook   Stripe → paid / expired (signature checked)
 *   GET  image/:id        a product's own picture
 *   GET  contact          the Kontakt page: { email, topics, mail }      POST contact  { name, email, topic, message }
 *                         – no sign-in needed (src/web/contact.js)
 *
 * Prices always come from the bot's catalog – never from the browser. A paid order is handed to the bot
 * (onPaid): an order ticket opens on Discord and the product is delivered like any other paid order. The order then
 * carries its ticket (number + link) and whether it was delivered – the page's receipt and My orders show them.
 *
 * Hammer Launcher has its own corner here: /api/launcher/* (featured servers, news, Hammer+ cloud sync and capes) and
 * the /join page – see src/web/launcher.js. Its pages (src/web/pages.js, the sources in web/pages/) are the whole site
 * on Hammer Launcher's own site and live under /launcher on HammerShop's: the download button (GET /download → the
 * installer in /updates/, which is also where the launcher's own updater looks – see src/web/releases.js), the news,
 * and Hammer+ bought by card:
 *
 *   GET  plus             { ready, plans [{ id, name, days, price }], currency } – the price list from the admin panel
 *   POST checkout         { kind: 'plus', plan, nick, requestId } → { url } – the nick is checked at Mojang first; once
 *                         paid, the bot issues the code for that Minecraft account (onPaid) and the order shows it
 *
 * Downloading the launcher from the website needs a Discord sign-in, like buying Hammer+: /download without a session
 * goes through Discord and back to the start page with ?download=1, where the page starts the download itself (the
 * sign-in never ends on a file – the browser would stay on Discord's page). Where sign-in is not set up, /download
 * just downloads.
 * /updates/* – the launcher's own updater – never asks for anything. „Zaproś znajomego” (/r/<code>, GET referrals,
 * POST referrals/claim) is in src/web/referrals.js.
 *
 * The admin panel is /admin (web/public/admin.html) with its API under /api/admin/ – see src/web/admin.js.
 */

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { env } = require('../env');
const store = require('./store');
const stripe = require('./stripe');
const discord = require('./discord');
const launcher = require('./launcher');
const admin = require('./admin');
const releases = require('./releases');
const referrals = require('./referrals');
const contact = require('./contact');
const pages = require('./pages');
const plusLib = require('../lib/plus');
const profile = require('../lib/profile');
const config = require('../lib/config');
const mail = require('../lib/mail');

const PUBLIC = path.join(__dirname, '..', '..', 'web', 'public');
const { stampAssets, unstamp, ASSET_REF } = require('./stamp');
const STRIPE_MIN = 50; // Stripe's smallest charge in EUR cents
const MAX_QTY = 10;
const web = () => env.web;
const secure = () => web().publicUrl.startsWith('https://');
const authReady = () => Boolean(discord.clientId() && web().clientSecret && web().publicUrl);
const paymentsReady = () => Boolean(env.stripeKey && web().publicUrl);
const webhookReady = () => Boolean(web().stripeWebhookSecret);
const plusOnSale = () => plusLib.ready() && paymentsReady() && authReady() && store.plusPlans().length > 0;

// ───────────── Products ─────────────
/** Set by createWebServer: { catalog, info, onPaid, receipt, onLogin, isMember, currency, featured, level, announce, log, plus, featuredAdmin, announcements }. */
/** The bot's own "the user did something wrong" errors (lib/utils.js UserError) – their text is written for Discord. */
const isUserError = (err) => err?.constructor?.name === 'UserError';
const plainMessage = (err) => String(err.message).replace(/\*\*|__|`/g, '');
const notConnected = async () => {
  throw Object.assign(new Error('Bot nie jest jeszcze połączony z Discordem – spróbuj ponownie za chwilę.'), { status: 503 });
};
let hooks = {
  catalog: () => [], info: () => ({}), onPaid: async () => null, receipt: async () => null, onLogin: async () => null, isMember: () => null, currency: () => 'eur', featured: () => [],
  // The admin panel and Hammer+ sales (src/features/website.js fills these in):
  level: async () => null, // (userId) → 'owner' | 'admin' | null
  announce: async () => null, // ({ kind, title, body, url, image, tag, version }) → { url } – posted on Discord
  log: async () => null, // (text) → the bot's log channel
  plus: { lookup: notConnected, grant: notConnected, recent: () => [], inspect: () => ({ valid: false, message: 'Bot nie jest połączony.' }), active: () => 0 },
  featuredAdmin: { list: () => [], add: notConnected, remove: notConnected },
  referrals: { claim: notConnected }, // (user, nick) → { code, nick, until, days } – the referral balance as a code
  contact: async () => null, // (message) → a card for the team on Discord (src/features/website.js contactCard)
  // The panel's „Ogłoszenia” tab: cards on #📢 ogłoszenia (src/features/website.js panelAnnouncements).
  announcements: { info: () => ({ channel: null, role: null, members: null, brand: null, bot: null, kinds: [] }), bannerFile: () => null, post: notConnected, remove: notConnected },
  // The panel's „Plany” tab: the card on #🗺️ plany (src/features/website.js panelRoadmap → src/features/roadmap.js).
  roadmap: { info: () => ({ channel: null, url: null }), publish: notConnected },
};
const products = () => hooks.catalog();
const publicProduct = (p) => ({ id: p.id, name: p.name, category: p.category, description: p.description, price: p.price, art: p.art, image: p.image ?? null, eta: p.eta ?? null, instant: Boolean(p.instant), published: true });

// ───────────── HTTP helpers ─────────────
const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...HEADERS, ...(json && { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }), ...headers });
  res.end(json ? JSON.stringify(body) : body);
}
const fail = (res, status, error) => send(res, status, { error });
const redirect = (res, to, cookies = []) => send(res, 302, '', { location: to, 'set-cookie': cookies, 'cache-control': 'no-store' });

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k, v]) => k && v !== undefined)
      .map(([k, ...v]) => {
        // One broken cookie of some other page on this domain ("x=100%") must not break every request.
        try {
          return [k, decodeURIComponent(v.join('='))];
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  );
}
const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure() ? '; Secure' : ''}`;

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Za duże zapytanie.'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw Object.assign(new Error('Wyślij dane w formacie JSON.'), { status: 415 });
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('Nieprawidłowy JSON.'), { status: 400 });
  }
}

/** POSTs from other sites are refused (the session cookie is SameSite=Lax too). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = [web().publicUrl, `http://${req.headers.host}`, `https://${req.headers.host}`].filter(Boolean);
  return allowed.includes(origin);
}

/** A change made in the admin panel must come from the panel: the browser's Origin header is required and must be this site. */
function originOk(req) {
  const origin = req.headers.origin;
  return Boolean(origin) && [web().publicUrl, `http://${req.headers.host}`, `https://${req.headers.host}`].filter(Boolean).includes(origin);
}

/**
 * Who may say who the visitor is: Cloudflare (its published ranges – cloudflare.com/ips) and this machine's own network
 * (127.x, 10.x, 172.16–31.x, 192.168.x, the hosting's container network, a Caddy / nginx on the same server). Anybody
 * else talks to the server's port directly – past Cloudflare – and could put any address into CF-Connecting-IP to dodge
 * every limit; for them the connection's own address counts.
 */
const PROXIES = new net.BlockList();
for (const range of ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16']) PROXIES.addSubnet(range.split('/')[0], Number(range.split('/')[1]), 'ipv4');
for (const range of ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32', '::1/128', 'fc00::/7', 'fe80::/10']) PROXIES.addSubnet(range.split('/')[0], Number(range.split('/')[1]), 'ipv6');
/** "::ffff:1.2.3.4" (an IPv4 connection on a dual-stack socket) → "1.2.3.4". */
const plainIp = (address) => String(address ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
const fromProxy = (address) => {
  const family = net.isIP(address);
  return family !== 0 && PROXIES.check(address, family === 6 ? 'ipv6' : 'ipv4');
};
let bypassSaid = false;

/**
 * Who is asking – for the per-address limits and counters. Behind Cloudflare it says so itself (CF-Connecting-IP).
 * Otherwise the last X-Forwarded-For entry is the one the own proxy (Caddy, nginx) added: the first one is whatever the
 * client wrote there, so it could dodge every limit with a made-up address. Both only when the connection comes from
 * Cloudflare or this machine's own network (PROXIES).
 */
const clientIp = (req) => {
  const peer = plainIp(req.socket?.remoteAddress);
  const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
  if (peer && !fromProxy(peer)) {
    if (cf && !bypassSaid) {
      bypassSaid = true;
      console.warn(`[web] Zapytanie z nagłówkiem CF-Connecting-IP przyszło spoza Cloudflare (${peer}) – ktoś łączy się z portem strony z pominięciem Cloudflare. Limity liczę wtedy po adresie połączenia.`);
    }
    return peer;
  }
  if (cf && cf.length <= 64) return cf;
  const hops = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.at(-1) || peer || '?';
};

// Simple per-IP limits: { key → [timestamps] }
const hits = new Map();
function limited(req, bucket, max, windowMs = 60_000) {
  const ip = clientIp(req);
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10_000) hits.clear();
  return list.length > max;
}

const userOf = (req) => store.sessionUser(cookies(req).hs_sid);
const sessionJson = (user) => ({
  user: user ? { id: user.id, name: user.name, username: user.username, avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null } : null,
  access: Boolean(user), // signed in = can buy
  member: user ? hooks.isMember(user.id) : null, // on the HammerShop Discord (null = unknown)
});

// ───────────── Orders ─────────────
function orderJson(order) {
  const paid = order.status === 'paid';
  return {
    id: order.id,
    kind: order.kind,
    items: order.items.map((i) => ({ id: i.id, name: i.name, price: i.price, quantity: i.quantity })),
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    created: order.created,
    stripe_id: order.stripe_id,
    delivery: paid ? order.delivery ?? null : null,
    ticketNumber: paid ? order.ticketNumber ?? null : null,
    ticketUrl: paid ? order.ticketUrl ?? null : null,
    delivered: paid && Boolean(order.delivered),
    waiting: paid && Boolean(order.waitingForMember && !order.handedOver),
    receipt: paid ? receiptJson(order) : null,
    ...(order.kind === 'plus' && { plus: plusJson(order) }),
  };
}

/**
 * The buyer's confirmation e-mail as the thank-you screen tells it: where it went (masked – the page is the buyer's
 * own, but a screenshot of it is not) and whether it left. dm: the code also reached their Discord DMs (Hammer+).
 */
function receiptJson(order) {
  const b = order.mails?.buyer;
  const state = b?.state === 'sent' ? 'sent' : b?.state === 'pending' ? 'sending' : b ? 'not-sent' : null;
  return { email: state === 'sent' || state === 'sending' ? mail.mask(b.to ?? order.email) : null, state, dm: typeof order.dm === 'boolean' ? order.dm : null };
}

/**
 * A Hammer+ order: whose it is, how long it runs and – once paid – the code. The code itself is never stored: it is
 * signed again from what the order holds (the same account, the same end date), so the database has nothing in it
 * that works as a code. expired: its time is over – such a code opens nothing any more, so it is not signed again and
 * the launcher's page leaves the order out of „Twoje kody” (many short plans would otherwise pile up there).
 */
function plusJson(order, now = Date.now()) {
  const p = order.plus ?? {};
  const expired = order.status === 'paid' && Boolean(p.exp) && p.exp * 1000 <= now; // exp 0 = forever
  let code = null;
  if (order.status === 'paid' && p.grantedAt && plusLib.ready() && !expired) {
    try {
      code = plusLib.issue({ mc: p.mc, days: p.grantDays ?? p.days, now: p.grantedAt, id: p.codeId ?? null }); // the code from the DM
    } catch {
      code = null;
    }
  }
  // Not on the Discord server: the invite to it, where the 💎 Hammer+ role comes on joining.
  const member = order.status === 'paid' ? hooks.isMember?.(order.userId) : null;
  const invite = member === false ? hooks.info?.()?.invite ?? null : null;
  const plan = String(order.items?.[0]?.name ?? 'Hammer+').replace(` – ${p.nick}`, ''); // "Hammer+ na 30 dni – Steve" → the plan
  return { nick: p.nick ?? null, days: p.days ?? null, plan, until: p.exp == null ? null : p.exp * 1000, expired, code, member: member ?? null, invite };
}

/** The address the buyer typed on Stripe's page (customer_details.email; customer_email when the session was made with one). */
const sessionEmail = (session) => [session?.customer_details?.email, session?.customer_email].map((v) => String(v ?? '').trim()).find((v) => mail.isAddress(v)) ?? null;

/**
 * Where the buyer's confirmation goes. A session object without the address (a webhook sent with a trimmed payload)
 * is read once more from Stripe – the buyer's e-mail depends on it. fresh: the session was just read from Stripe.
 */
async function buyerEmail(order, session, fresh) {
  const found = sessionEmail(session);
  if (found || fresh || order.email || !session.id || !paymentsReady()) return found ?? order.email ?? null;
  const full = await stripe.getCheckout(session.id).catch((err) => {
    console.warn(`[web] ${order.id}: adres e-mail kupującego ze Stripe:`, err.message);
    return null;
  });
  return sessionEmail(full);
}

/**
 * Stripe says paid (verify or webhook) → the order is paid once; the team is told once. The order keeps the buyer's
 * e-mail address from the session (order.email) – their confirmation with the code goes there (src/features/website.js).
 */
async function settle(order, session, { fresh = false } = {}) {
  if (!order || !session) return order;
  if (session.payment_status === 'paid') {
    const amountOk = session.amount_total === order.amount && String(session.currency).toLowerCase() === order.currency;
    if (!amountOk) {
      console.warn(`[web] ${order.id}: kwota w Stripe ${session.amount_total} ${session.currency} ≠ zamówienie ${order.amount} ${order.currency} – nie oznaczono jako opłacone`);
      return store.updateOrder(order.id, { status: 'failed', note: 'amount mismatch' });
    }
    const email = order.status === 'paid' && order.email ? order.email : await buyerEmail(order, session, fresh);
    const { order: paid, first } = store.markPaid(order.id, { payment_intent: session.payment_intent ?? null, email });
    if (!first && email && !paid.email) {
      // Paid already through the other path, which had no address: the buyer's confirmation goes out now.
      store.updateOrder(paid.id, { email });
      await Promise.resolve(hooks.receipt(paid)).catch(() => null);
    }
    if (first) {
      console.log(`[web] zamówienie ${paid.id} opłacone – ${paid.kind} – ${(paid.amount / 100).toFixed(2)} ${paid.currency}`);
      await Promise.resolve(hooks.onPaid(paid, store._state().users[paid.userId])).catch((err) => console.warn(`[web] przekazanie ${paid.id} do bota:`, err.message));
    }
    return paid;
  }
  if (session.status === 'expired' && order.status === 'pending') return store.updateOrder(order.id, { status: 'expired' });
  return order;
}

async function checkout(req, res, user) {
  if (!paymentsReady()) return fail(res, 503, 'Płatności nie są jeszcze uruchomione. Nic nie zostało pobrane.');
  if (limited(req, 'checkout', 10)) return fail(res, 429, 'Zbyt wiele prób – odczekaj minutę i spróbuj ponownie.');
  const body = await jsonBody(req);
  if (body.kind === 'access') return fail(res, 409, 'Wystarczy zalogować się przez Discord – nie ma opłaty za dostęp.');
  if (body.kind !== 'products' && body.kind !== 'plus') return fail(res, 400, 'Nieznany rodzaj zamówienia.');
  const kind = 'products';
  const requestId = String(body.requestId ?? '').slice(0, 100) || crypto.randomUUID();

  // The same click twice (double click, back button) → the same payment page.
  const again = store.orderByRequest(user.id, requestId);
  if (again?.status === 'pending' && again.url) return send(res, 200, { url: again.url, order: again.id });
  if (body.kind === 'plus') return checkoutPlus(res, user, body, requestId);

  const list = products();
  const wanted = new Map();
  for (const it of Array.isArray(body.items) ? body.items.slice(0, 50) : []) {
    const qty = Number(it?.quantity);
    if (!Number.isInteger(qty) || qty < 1) continue;
    wanted.set(String(it.id), Math.min(MAX_QTY, (wanted.get(String(it.id)) ?? 0) + qty));
  }
  const items = [];
  for (const [id, quantity] of wanted) {
    const p = list.find((x) => x.id === id);
    if (!p) return fail(res, 400, 'Coś z Twojego koszyka nie jest już dostępne. Usuń to i spróbuj ponownie.');
    items.push({ id: p.id, name: p.name, price: p.price, quantity: Math.min(MAX_QTY, quantity), productId: p.productId ?? null, variant: p.variant ?? null, eta: p.eta ?? null });
  }
  if (!items.length) return fail(res, 400, 'Twój koszyk jest pusty.');
  const lines = items.map((i) => ({ name: i.name, amount: i.price, quantity: i.quantity, description: i.eta ? `${i.eta} · na Discordzie` : 'Dostawa na Discordzie' }));
  const amount = items.reduce((s, i) => s + i.price * i.quantity, 0);
  if (amount < STRIPE_MIN) return fail(res, 400, 'Kwota jest niższa niż najmniejsza płatność kartą (0.50 €).');

  const currency = hooks.currency();
  const order = store.createOrder({ userId: user.id, kind, items, amount, currency, requestId });
  try {
    const session = await stripe.createCheckout({ order, user, lines, currency, idempotencyKey: `hs-${order.id}` });
    store.updateOrder(order.id, { stripe_id: session.id, url: session.url });
    return send(res, 200, { url: session.url, order: order.id });
  } catch (err) {
    store.updateOrder(order.id, { status: 'failed', note: err.message });
    console.warn(`[web] płatność ${order.id}:`, err.message);
    return fail(res, 502, err.status === 401 ? `Płatności nie są jeszcze poprawnie skonfigurowane – skontaktuj się z ${config.brand.name}.` : 'Nie udało się otworzyć strony płatności. Spróbuj ponownie.');
  }
}

/** Hammer+ for one Minecraft account: the plan's price from the admin panel, the nick checked at Mojang before anyone pays. */
async function checkoutPlus(res, user, body, requestId) {
  if (!plusOnSale()) return fail(res, 503, 'Hammer+ nie jest jeszcze w sprzedaży na stronie. Nic nie zostało pobrane.');
  const plan = store.plusPlans().find((p) => p.id === String(body.plan ?? ''));
  if (!plan) return fail(res, 400, 'Nie ma już takiego planu Hammer+ – odśwież stronę i wybierz ponownie.');
  let account;
  try {
    account = await hooks.plus.lookup(String(body.nick ?? ''));
  } catch (err) {
    if (!isUserError(err) && !err.status) throw err;
    return fail(res, err.status ?? 400, plainMessage(err));
  }
  // Hammer+ forever already: another plan would add nothing – nobody pays for that.
  if (hooks.plus.until?.(account.mc) === 0) return fail(res, 409, `Konto ${account.nick} ma już Hammer+ na zawsze – nie musisz go kupować ponownie. Nic nie zostało pobrane.`);
  const currency = hooks.currency();
  // What Stripe's page shows above and under the price – config.launcher.json → checkout (plusName, plusDescription), with
  // {plan} (the plan's name from the admin panel), {nick}, {time} („30 dni” / „na zawsze”) and {days}.
  const fill = (template, fallback) => {
    const time = plan.days ? `${plan.days} dni` : 'na zawsze';
    const text = String(template ?? '').replace(/\{(plan|nick|time|days)\}/g, (_, k) => ({ plan: plan.name, nick: account.nick, time, days: String(plan.days ?? '') })[k]).replace(/\s+/g, ' ').trim();
    return text || fallback;
  };
  const name = fill(config.checkout?.plusName, `${plan.name} – ${account.nick}`).slice(0, 200);
  const description = fill(config.checkout?.plusDescription, '').slice(0, 500);
  const items = [{ id: `plus:${plan.id}`, name, price: plan.price, quantity: 1, productId: null, variant: null, eta: 'Kod od razu po płatności' }];
  const order = store.createOrder({ userId: user.id, kind: 'plus', items, amount: plan.price, currency, requestId, plus: { plan: plan.id, days: plan.days, mc: account.mc, nick: account.nick } });
  try {
    const session = await stripe.createCheckout({
      order, user, currency, idempotencyKey: `hs-${order.id}`, returnPath: pages.pathOf('hammer-plus'),
      lines: [{ name, amount: plan.price, quantity: 1, ...(description && { description }) }],
      // The line under Stripe's Pay button – config.launcher.json → checkout.plusMessage (Stripe takes up to 1200 characters).
      message: String(config.checkout?.plusMessage ?? '').trim().slice(0, 1200), // '' = no line
    });
    store.updateOrder(order.id, { stripe_id: session.id, url: session.url });
    return send(res, 200, { url: session.url, order: order.id });
  } catch (err) {
    store.updateOrder(order.id, { status: 'failed', note: err.message });
    console.warn(`[web] płatność ${order.id}:`, err.message);
    return fail(res, 502, err.status === 401 ? `Płatności nie są jeszcze poprawnie skonfigurowane – skontaktuj się z ${config.brand.name}.` : 'Nie udało się otworzyć strony płatności. Spróbuj ponownie.');
  }
}

async function verify(req, res, user) {
  if (limited(req, 'verify', 30)) return fail(res, 429, 'Zbyt wiele prób – odczekaj minutę i spróbuj ponownie.');
  const { sessionId } = await jsonBody(req);
  const order = sessionId ? store.orderByStripe(String(sessionId)) : null;
  if (!order || order.userId !== user.id) return fail(res, 404, 'Nie znaleziono tej płatności na Twoim koncie.');
  if (order.status === 'paid') return send(res, 200, { paid: true, status: 'paid', order: order.id });
  if (!paymentsReady()) return fail(res, 503, 'Płatności są teraz niedostępne.');
  const session = await stripe.getCheckout(order.stripe_id).catch((err) => {
    console.warn(`[web] sprawdzanie ${order.id}:`, err.message);
    return null;
  });
  if (!session) return fail(res, 502, 'Brak połączenia ze Stripe. Spróbuj ponownie za chwilę.');
  const updated = await settle(order, session, { fresh: true });
  return send(res, 200, { paid: updated.status === 'paid', status: updated.status, order: updated.id });
}

async function webhook(req, res) {
  const raw = await readBody(req, 512 * 1024);
  let event;
  try {
    event = stripe.verifyWebhook(raw, req.headers['stripe-signature']);
  } catch (err) {
    return fail(res, 400, `Webhook: ${err.message}`);
  }
  const s = event.data?.object ?? {};
  const order = (s.metadata?.order_id && store.getOrder(s.metadata.order_id)) || (s.id && store.orderByStripe(s.id));
  if (order && ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired'].includes(event.type)) {
    await settle(order, s);
  } else if (order && event.type === 'checkout.session.async_payment_failed' && order.status === 'pending') {
    store.updateOrder(order.id, { status: 'failed' });
  }
  return send(res, 200, { received: true });
}

/**
 * Paid orders nobody told the site about: the webhook did not come (no STRIPE_WEBHOOK_SECRET, the test-mode secret left
 * next to live keys, a proxy that stopped Stripe) and the buyer closed the tab before Stripe sent them back – a phone
 * switching to the bank's app for BLIK does that easily. Every few minutes the open payment pages are read back from
 * Stripe: a paid one is settled exactly like on the buyer's return (the code, the DM, the e-mails), an expired one is
 * marked so. A payment page lives an hour (expires_at), so an order is asked about for a little longer and then never
 * again. → how many orders became paid
 */
const RECHECK_MS = 5 * 60_000;
const RECHECK_FROM_MS = 60_000; // the buyer is most likely still on Stripe's page – their return or the webhook comes first
const RECHECK_UNTIL_MS = 3 * 3600_000;
async function recheckPending(now = Date.now()) {
  if (!paymentsReady()) return 0;
  const open = store.allOrders().filter((o) => o.status === 'pending' && o.stripe_id && now - o.created * 1000 >= RECHECK_FROM_MS && now - o.created * 1000 <= RECHECK_UNTIL_MS);
  let paid = 0;
  for (const order of open) {
    const session = await stripe.getCheckout(order.stripe_id).catch((err) => {
      console.warn(`[web] sprawdzanie ${order.id}:`, err.message);
      return null;
    });
    if (!session) continue;
    const after = await settle(store.getOrder(order.id), session, { fresh: true });
    if (after?.status === 'paid') {
      paid += 1;
      console.log(`[web] ${order.id}: płatność potwierdzona przy sprawdzaniu otwartych zamówień (bez powiadomienia ze Stripe – sprawdź webhook)`);
    }
  }
  return paid;
}

// ───────────── Discord sign-in ─────────────
/**
 * Where sign-in may send people back to (?next=<name>) – only pages of this site, by name, never an address: the
 * admin panel and the launcher's pages, each under its own id (hammer-plus, polecaj, kontakt …), so the visitor lands
 * on the page the button was on. launcher: the start page; download: the start page, which then starts the download.
 */
const NEXT = { admin: '/admin', ...pages.signInTargets() };
/** "/polecaj#karta" + "connected=1" → "/polecaj?connected=1#karta" (and & when there is a query already). */
function withQuery(target, query) {
  const [pathAndQuery, hash] = target.split('#');
  return `${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}${query}${hash ? `#${hash}` : ''}`;
}

function authStart(req, res, url) {
  const name = url.searchParams.get('next') ?? '';
  const next = Object.hasOwn(NEXT, name) ? NEXT[name] : null; // (not "constructor" and the like, which every object has)
  if (!authReady()) return redirect(res, withQuery(next ?? '/', 'auth=unavailable'));
  const state = crypto.randomBytes(16).toString('base64url');
  return redirect(res, discord.authorizeUrl(state), [cookie('hs_oauth', state, 600), cookie('hs_next', next ?? '', next ? 600 : 0)]);
}

async function authCallback(req, res, url) {
  const back = Object.values(NEXT).includes(cookies(req).hs_next) ? cookies(req).hs_next : '/';
  const clear = [cookie('hs_oauth', '', 0), cookie('hs_next', '', 0)];
  if (url.searchParams.get('error')) return redirect(res, withQuery(back, 'auth=cancelled'), clear);
  const state = url.searchParams.get('state');
  const expected = cookies(req).hs_oauth;
  if (!state || !expected || state.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
    return redirect(res, withQuery(back, 'auth=failed'), clear);
  }
  try {
    const { me, accessToken } = await discord.userFromCode(String(url.searchParams.get('code') ?? ''));
    // „Zaproś znajomego”: a friend's link counts only at the very first sign-in on the site (src/web/referrals.js).
    const firstTime = !store.siteUserExists(me.id);
    const refCode = cookies(req)[referrals.COOKIE];
    if (refCode) clear.push(cookie(referrals.COOKIE, '', 0));
    const user = store.upsertUser(me);
    if (firstTime && refCode) referrals.onFirstSignIn(user, refCode);
    // Not on the HammerShop Discord yet → the bot adds them (Member role included). Signing in never fails because of it.
    const joined = await Promise.resolve(hooks.onLogin(user, accessToken)).catch((err) => {
      console.warn(`[web] dodawanie ${user.id} do serwera:`, err.message);
      return null;
    });
    const token = store.createSession(user.id);
    return redirect(res, withQuery(back, `connected=1${joined?.added ? '&joined=1' : ''}`), [...clear, cookie('hs_sid', token, 30 * 86_400)]);
  } catch (err) {
    console.warn('[web] logowanie:', err.message);
    return redirect(res, withQuery(back, 'auth=failed'), clear);
  }
}

/**
 * The download button. Signed in (or no Discord sign-in set up on this server) → the installer, counted – also for the
 * signed-in account (the referral card shows how many of your friends downloaded it). Not signed in → Discord first.
 */
function download(req, res) {
  const release = store.currentRelease();
  if (!release) return redirect(res, `${pages.HOME}?download=none`);
  const user = userOf(req);
  if (!user && authReady()) return authStart(req, res, new URL('/?next=download', 'http://local'));
  if (req.method === 'GET' && !limited(req, 'download', 20)) {
    store.countDownload(release.version);
    if (user) store.countUserDownload(user.id);
  }
  return redirect(res, releases.downloadPath(release)); // the address Cloudflare may keep (src/web/releases.js)
}

// ───────────── Pages and static files ─────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webm': 'video/webm', '.mp4': 'video/mp4', '.css': 'text/css', '.js': 'text/javascript', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };
/** The launcher's pages and the admin panel load nothing but their own files (and pictures over https). */
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; media-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** The admin panel – also under its file name: never the raw file, which has both sites' parts and no CSP. */
const ADMIN = ['/admin', '/admin.html'];
const INDEX = path.join(PUBLIC, 'index.html'); // the shop's own page
/**
 * The admin panel's page as this site shows it. The same file serves both sites: what is between <!--shop--> …
 * <!--/shop--> is only for HammerShop's site, <!--launcher--> … <!--/launcher--> only for Hammer Launcher's own
 * (BOT_PROFILE=launcher). The launcher's pages are put together the same way in src/web/pages.js.
 */
function pageHtml(file) {
  return pages.forProfile(fs.readFileSync(path.join(PUBLIC, file), 'utf8')).replace(ASSET_REF, (url) => stampAssets(url));
}
function sendPage(req, res, status, html, extra = {}) {
  res.writeHead(status, { ...HEADERS, 'content-type': TYPES['.html'], 'cache-control': 'no-cache', 'content-security-policy': PAGE_CSP, ...extra });
  return res.end(req.method === 'HEAD' ? undefined : html);
}
/** The site's whole address for robots.txt and the sitemap: PUBLIC_URL, or – without one – the host this server was asked as. */
function siteOrigin(req) {
  if (web().publicUrl) return web().publicUrl;
  const host = String(req.headers.host ?? '');
  return /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) ? `http://${host}` : '';
}

function serveStatic(req, res, pathname) {
  pathname = unstamp(pathname); // /assets/_v/<stamp>/… is the same file – the stamp only makes a changed file a new address
  if (ADMIN.includes(pathname.replace(/\/+$/, ''))) return sendPage(req, res, 200, pageHtml('admin.html'), { 'x-robots-tag': 'noindex' });
  // Hammer Launcher's own site tells search engines which pages it has – and that the panel and the API are not for them.
  if (profile.launcher && (pathname === '/robots.txt' || pathname === '/sitemap.xml')) {
    const ext = path.extname(pathname);
    return send(res, 200, ext === '.txt' ? pages.robots(siteOrigin(req)) : pages.sitemap(siteOrigin(req)), { 'content-type': TYPES[ext], 'cache-control': 'public, max-age=3600' });
  }
  // The launcher's pages (src/web/pages.js). On its own site they are the whole site; an address that is nothing gets
  // a real 404. The addresses of the one long page it used to be lead to the page that has that part now.
  const hit = pages.resolve(pathname);
  const query = new URL(req.url, 'http://local').search;
  if (hit?.redirect) return redirect(res, hit.redirect + query + (hit.hash ? `#${hit.hash}` : '')); // (/wyglad → /funkcje#wyglad)
  if (hit && !hit.page.missing) {
    // Back from Stripe to an address made before Hammer+ had its own page (a payment page stays open for an hour).
    if (hit.page.id === 'start' && /[?&]payment=/.test(query)) return redirect(res, pages.pathOf('hammer-plus') + query);
    return sendPage(req, res, 200, pages.render(hit.page, web().publicUrl));
  }
  const file = pathname === '/' || pathname === '/index.html' ? INDEX : path.join(PUBLIC, path.normalize(pathname).replace(/^([/\\])+/, ''));
  // (a page is never served as a plain file: the panel and the launcher's pages are answered above)
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile() || (path.extname(file) === '.html' && file !== INDEX)) {
    if (hit) return sendPage(req, res, 404, pages.render(hit.page, web().publicUrl), { 'x-robots-tag': 'noindex' });
    // Unknown paths show the store (single page) – but not for missing assets.
    if (pathname.startsWith('/assets/')) return fail(res, 404, 'Nie znaleziono');
    return serveStatic(req, res, '/');
  }
  const ext = path.extname(file);
  const cache = ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=604800, immutable'; // pages and their code are always fresh, pictures keep
  if (ext === '.css' || ext === '.html') {
    // A stylesheet (url(/assets/…)) or a plain page names pictures and fonts – they get their stamps like on the pages.
    res.writeHead(200, { ...HEADERS, 'content-type': TYPES[ext], 'cache-control': cache });
    return res.end(req.method === 'HEAD' ? undefined : stampAssets(fs.readFileSync(file, 'utf8')));
  }
  const head = { ...HEADERS, 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': cache, 'accept-ranges': 'bytes' };
  // The page's short clips (.webm/.mp4): browsers ask for parts of a video (Safari only plays a video it can ask that way).
  const size = fs.statSync(file).size;
  const range = releases.parseRange(req.headers.range, size);
  if (range === false) return send(res, 416, '', { ...head, 'content-range': `bytes */${size}` });
  if (range) {
    res.writeHead(206, { ...head, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': range.end - range.start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ───────────── Router ─────────────
async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  // Hammer Launcher: featured servers, Hammer+ cloud sync and capes (src/web/launcher.js).
  if (p.startsWith(launcher.PREFIX)) return launcher.api(req, res, url, { send, fail, limited, featured: () => hooks.featured(), publicUrl: () => web().publicUrl, ip: clientIp, plusOf: (mc) => Boolean(hooks.plus?.running?.(mc)), freshCode: (mc, exp) => hooks.plus?.freshCode?.(mc, exp) ?? null });
  // The admin panel (src/web/admin.js).
  if (p.startsWith(admin.PREFIX)) {
    return admin.api(req, res, url, {
      send, fail, jsonBody, userOf, limited, originOk,
      level: (id) => hooks.level(id), announce: (a) => hooks.announce(a), log: (t) => hooks.log(t),
      plus: hooks.plus, featured: hooks.featuredAdmin, currency: () => hooks.currency(), announcements: hooks.announcements, roadmap: hooks.roadmap,
      publicUrl: () => web().publicUrl, authReady, paymentsReady, webhookReady, playing: () => launcher.onlineNow(), invitesPaused: () => Boolean(hooks.invitesPaused?.()), ownInviteFailing: () => Boolean(hooks.ownInviteFailing?.()),
      statsReset: () => hooks.statsReset?.(),
    });
  }
  if (!p.startsWith('/api/shop/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Niedozwolona metoda');
    if (p === '/join' || p === '/join/') return launcher.join(req, res, url, { send }); // "join this server" links → the launcher
    // Hammer Launcher's installer: the download button, and the feed its own updater reads (src/web/releases.js).
    if (p === '/download' || p === '/download/') return download(req, res);
    // „Zaproś znajomego”: a personal link (src/web/referrals.js).
    const ref = /^\/r\/([A-Za-z0-9]{1,32})\/?$/.exec(p);
    if (ref) {
      if (limited(req, 'referral-link', 60)) return fail(res, 429, 'Zwolnij trochę i spróbuj ponownie.');
      return referrals.visit(res, ref[1], { redirect, cookie });
    }
    if (p.startsWith('/updates/')) {
      if (limited(req, 'updates', 600)) return fail(res, 429, 'Zwolnij trochę i spróbuj ponownie.');
      let name = null;
      try {
        name = decodeURIComponent(p.slice('/updates/'.length));
      } catch {
        return fail(res, 404, 'Nie znaleziono'); // a broken %-escape is not a file name
      }
      return releases.serve(req, res, name, { send, fail, headers: HEADERS });
    }
    return serveStatic(req, res, p);
  }
  const route = p.slice('/api/shop/'.length);
  if (limited(req, 'api', 120)) return fail(res, 429, 'Zwolnij trochę i spróbuj ponownie.');

  if (req.method === 'GET') {
    if (route === 'health') return send(res, 200, { ok: true });
    if (route === 'store') {
      const live = authReady() && paymentsReady();
      return send(res, 200, {
        products: products().map(publicProduct),
        // Without Discord sign-in and Stripe the page shows its clearly marked offline preview (demo account).
        preview: !live,
        authReady: authReady(),
        paymentsReady: paymentsReady(),
        accessPrice: null, // no access fee – signing in with Discord is enough
        discordUrl: hooks.info().invite || null,
        currency: hooks.currency(), // prices are in the smallest unit (cents / grosze)
      });
    }
    if (route === 'session') return send(res, 200, sessionJson(userOf(req)));
    if (route === 'plus') return send(res, 200, { ready: plusOnSale(), plans: plusOnSale() ? store.plusPlans() : [], currency: hooks.currency(), authReady: authReady() });
    if (route === 'referrals') return send(res, 200, { ...referrals.pageJson(userOf(req), web().publicUrl), authReady: authReady() });
    if (route === 'contact') return contact.get(res, { send });
    if (route === 'auth/start') return authStart(req, res, url);
    if (route === 'auth/callback') return authCallback(req, res, url);
    if (route.startsWith('image/')) {
      const p = products().find((x) => x.id === decodeURIComponent(route.slice(6)));
      if (!p?.imagePath || !fs.existsSync(p.imagePath)) return fail(res, 404, 'Nie znaleziono');
      res.writeHead(200, { ...HEADERS, 'content-type': TYPES[path.extname(p.imagePath)] ?? 'image/png', 'cache-control': 'public, max-age=300' });
      return fs.createReadStream(p.imagePath).pipe(res);
    }
    if (route === 'orders') {
      const user = userOf(req);
      if (!user) return fail(res, 401, 'Zaloguj się przez Discord, aby zobaczyć swoje zamówienia.');
      return send(res, 200, { orders: store.ordersOf(user.id).filter((o) => o.stripe_id || o.status === 'paid').map(orderJson) });
    }
    return fail(res, 404, 'Nie znaleziono');
  }

  if (req.method === 'POST') {
    if (route === 'stripe/webhook') return webhook(req, res);
    if (!sameOrigin(req)) return fail(res, 403, 'Żądanie odrzucone.');
    if (route === 'logout') {
      store.endSession(cookies(req).hs_sid);
      return send(res, 200, { ok: true }, { 'set-cookie': cookie('hs_sid', '', 0) });
    }
    // The contact form is for everybody – signed in or not (the Discord account is attached when there is one).
    if (route === 'contact') return contact.post(req, res, { send, fail, jsonBody, limited, user: userOf(req), notify: (message) => hooks.contact(message) });
    const user = userOf(req);
    if (!user) return fail(res, 401, 'Najpierw zaloguj się przez Discord.');
    if (route === 'checkout') return checkout(req, res, user);
    if (route === 'verify') return verify(req, res, user);
    if (route === 'referrals/claim') return referrals.claim(req, res, user, { send, fail, jsonBody, limited, claim: (u, nick) => hooks.referrals.claim(u, nick) });
    return fail(res, 404, 'Nie znaleziono');
  }
  return fail(res, 405, 'Niedozwolona metoda');
}

/**
 * The website server. h: { catalog() → products, info() → { invite }, onPaid(order, user),
 * onLogin(user, accessToken) → { added, member }, isMember(userId) → true | false | null, currency() → 'eur',
 * featured() → the servers Hammer Launcher recommends }.
 */
function createWebServer(h = {}) {
  hooks = { ...hooks, ...h };
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status ?? (isUserError(err) ? 400 : null); // a wrong nick, address, version… – said plainly
      if (!status) console.error('[web]', err);
      if (!res.headersSent) fail(res, status ?? 500, status ? plainMessage(err) : 'Coś poszło nie tak po naszej stronie. Spróbuj ponownie.');
      else res.end();
    });
  });
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    recheckPending().catch((err) => console.warn('[web] sprawdzanie otwartych zamówień:', err.message)).finally(() => (checking = false));
  }, RECHECK_MS);
  timer.unref?.();
  server.on('close', () => clearInterval(timer));
  return server;
}

module.exports = { createWebServer, authReady, paymentsReady, webhookReady, plusOnSale, recheckPending, clientIp };
