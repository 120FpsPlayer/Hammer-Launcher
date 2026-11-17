'use strict';

/**
 * The website's contact form (the Kontakt page) – /api/shop/contact:
 *
 *   GET   → { email (the public contact address | null), topics [{ id, label }], mail (e-mail sending is set up) }
 *   POST  { name, email, topic, message, website } → { ok: true } | 400 / 429 { error (a Polish sentence for the page) }
 *         No sign-in needed. `website` is a honeypot the page keeps empty – a filled one is answered 200 and dropped.
 *         Limits: name 2–60, e-mail ≤ 120 and valid, message 10–2000 characters; 3 messages in 10 minutes and 10 a
 *         day from one address (and 30 an hour, 200 a day from everybody together).
 *
 * Every message is stored first (src/web/store.js → messages; the admin panel's „Wiadomości” tab) – that part depends
 * on nothing else. Then, once the visitor has their answer: an e-mail to the contact address with Reply-To set to the
 * visitor, so "Reply" just works (src/lib/mail.js – when it is set up), and a card for the team on Discord
 * (h.notify → src/features/website.js contactCard). Neither can fail the message: what happened to the e-mail is
 * written on the stored message.
 */

const config = require('../lib/config');
const mail = require('../lib/mail');
const store = require('./store');
const { env } = require('../env');
const { line, block } = require('./admin');

/** The ids are fixed – the page, the stored messages and the panel all use them. */
const TOPICS = [
  { id: 'launcher', label: 'Pomoc z launcherem' },
  { id: 'plus', label: 'Hammer+ i płatności' },
  { id: 'bug', label: 'Zgłoszenie błędu' },
  { id: 'collab', label: 'Współpraca' },
  { id: 'other', label: 'Inne' },
];
const LIMITS = { nameMin: 2, nameMax: 60, emailMax: 120, messageMin: 10, messageMax: 2000 };
const WINDOW_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const PER_WINDOW = 3;
const PER_DAY = 10;
// Everybody together: a script with many addresses must not bury the inbox and the team chat – or use up what a free
// mailbox may send in a day (Gmail: 500), which the purchase e-mails need too.
const SITE_PER_HOUR = 30;
const SITE_PER_DAY = 200;

const topicLabel = (id) => TOPICS.find((t) => t.id === id)?.label ?? 'Inne';
const problem = (status, message) => Object.assign(new Error(message), { status });
const text = (value) => (typeof value === 'string' ? value : '');
/** "17.11.2026, 09:41" – the shop's own time. */
const plDateTime = (ms) => new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' }).format(new Date(ms));

const info = () => ({ email: config.contact?.email || null, topics: TOPICS, mail: mail.ready() });

/** The form, checked – every message is one the page can show as it is. */
function fields(body) {
  const name = line(text(body.name), 500);
  if (name.length < LIMITS.nameMin) throw problem(400, 'Wpisz swoje imię albo nick – co najmniej 2 znaki.');
  if (name.length > LIMITS.nameMax) throw problem(400, `Imię albo nick może mieć najwyżej ${LIMITS.nameMax} znaków.`);
  const email = line(text(body.email), 500);
  if (!email) throw problem(400, 'Wpisz swój adres e-mail – na niego odpiszemy.');
  if (email.length > LIMITS.emailMax) throw problem(400, `Adres e-mail może mieć najwyżej ${LIMITS.emailMax} znaków.`);
  if (!mail.isAddress(email)) throw problem(400, 'Ten adres e-mail wygląda na błędny – sprawdź, czy nie ma w nim literówki.');
  if (!TOPICS.some((t) => t.id === body.topic)) throw problem(400, 'Wybierz temat wiadomości.');
  const message = block(text(body.message), 20_000);
  if (message.length < LIMITS.messageMin) throw problem(400, `Napisz wiadomość – co najmniej ${LIMITS.messageMin} znaków.`);
  if (message.length > LIMITS.messageMax) throw problem(400, `Wiadomość może mieć najwyżej ${LIMITS.messageMax} znaków (teraz ${message.length}).`);
  return { name, email, topic: body.topic, text: message };
}

/** The e-mail the team gets – plain text, short lines: it is read on a phone. */
function mailFor(m) {
  const panel = env.web.publicUrl ? `${env.web.publicUrl}/admin#wiadomosci` : null;
  const who = m.user ? `${m.user.name ?? m.user.username}${m.user.username ? ` (@${m.user.username})` : ''}, ID ${m.user.id}` : 'niezalogowany';
  return {
    subject: `[Kontakt] ${topicLabel(m.topic)} – ${m.name}`,
    replyTo: m.email,
    text: [
      `Nowa wiadomość z formularza kontaktowego na stronie ${config.brand.name}.`,
      '',
      `Od: ${m.name}`,
      `E-mail: ${m.email}`,
      `Temat: ${topicLabel(m.topic)}`,
      `Discord: ${who}`,
      `Kiedy: ${plDateTime(m.at)}`,
      '',
      '----------------------------------------',
      m.text,
      '----------------------------------------',
      '',
      `Żeby odpisać, kliknij „Odpowiedz” – odpowiedź trafi prosto do tej osoby (${m.email}).`,
      panel ? `Wszystkie wiadomości: ${panel}` : null,
    ].filter((l) => l !== null).join('\n'),
  };
}

const sending = new Set(); // deliveries on their way – settled() lets the tests wait for them
let recent = []; // when the accepted messages of the last day came (all visitors)

/** After the answer: the e-mail and the Discord card. Never throws. */
async function deliver(message, h) {
  const card = Promise.resolve()
    .then(() => h.notify?.(message))
    .catch((err) => console.warn('[kontakt] karta na Discordzie:', err.message));
  if (message.mail === 'pending') {
    const sent = await mail.send(mailFor(message));
    store.updateMessage(message.id, sent.ok ? { mail: 'sent', mailError: null } : { mail: 'failed', mailError: sent.reason });
  }
  await card;
}

/** GET /api/shop/contact */
const get = (res, h) => h.send(res, 200, info());

/** POST /api/shop/contact – h: { send, fail, jsonBody, limited, user (the signed-in account | null), notify(message) }. */
async function post(req, res, h) {
  const body = Object(await h.jsonBody(req)); // (a JSON null is an empty form, not a crash)
  // The honeypot: a field people never see. A script that fills it hears "sent" and nothing is kept.
  if (text(body.website).trim()) return h.send(res, 200, { ok: true });
  const form = fields(body);
  // Only a message that could be sent counts towards the limits – a typo in the address costs nothing.
  if (h.limited(req, 'contact', PER_WINDOW, WINDOW_MS)) return h.fail(res, 429, 'Za dużo wiadomości w krótkim czasie – następną możesz wysłać za 10 minut.');
  if (h.limited(req, 'contact-day', PER_DAY, DAY_MS)) return h.fail(res, 429, 'To już dużo wiadomości jak na jeden dzień – następną możesz wysłać jutro. Pilna sprawa? Napisz do nas na Discordzie.');
  const now = Date.now();
  recent = recent.filter((t) => now - t < DAY_MS);
  if (recent.length >= SITE_PER_DAY) return h.fail(res, 429, 'Dostaliśmy dziś wyjątkowo dużo wiadomości – spróbuj ponownie jutro albo napisz do nas na Discordzie.');
  if (recent.filter((t) => now - t < 3_600_000).length >= SITE_PER_HOUR) return h.fail(res, 429, 'Dostajemy teraz wyjątkowo dużo wiadomości – spróbuj ponownie za godzinę albo napisz do nas na Discordzie.');
  recent.push(now);

  const user = h.user ? { id: String(h.user.id), name: h.user.name ?? h.user.username ?? null, username: h.user.username ?? null } : null;
  const message = store.addMessage({ ...form, user, mail: mail.ready() ? 'pending' : 'off' });
  h.send(res, 200, { ok: true });
  const job = deliver(message, h)
    .catch((err) => console.warn('[kontakt] powiadomienie o wiadomości:', err.message))
    .finally(() => sending.delete(job));
  sending.add(job);
  return null;
}

module.exports = {
  TOPICS, LIMITS, topicLabel, info, get, post, mailFor, plDateTime,
  /** Tests: every e-mail and Discord card of the messages so far is out (or has failed). */
  settled: () => Promise.all([...sending]),
  _reset: () => (recent = []),
};
