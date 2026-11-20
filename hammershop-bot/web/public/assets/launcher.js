/* One script for all the launcher's pages (web/pages/, put together by src/web/pages.js). Every part starts only when
   the page has its elements: the header (who is signed in, the menu on small screens), the download buttons (after a
   Discord sign-in), the news, Hammer+ bought by card and „Twoje kody”, „Zaproś znajomego”, the contact form, the
   partners' „Kopiuj IP”. At the end: the look (scroll reveal, the feature tabs and clips, the three parts of the
   Funkcje page, 3D, the theme deck). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var all = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };
  var el = function (tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'class') node.className = props[k];
      else if (k === 'text') node.textContent = props[k];
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  };
  var api = function (path, options) {
    return fetch(path, Object.assign({ credentials: 'same-origin', headers: { accept: 'application/json' } }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw Object.assign(new Error(body.error || 'Coś poszło nie tak. Spróbuj ponownie.'), { status: res.status });
        return body;
      });
    }, function () {
      throw new Error('Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.'); // the browser's own text is English
    });
  };
  var post = function (path, body) { return api(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }); };
  var toastTimer = null;
  function toast(text, bad) {
    var t = $('toast');
    t.textContent = text;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 5000);
  }
  var money = function (amount, currency) {
    try { return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: String(currency || 'eur').toUpperCase() }).format(amount / 100); } catch (e) { return (amount / 100).toFixed(2) + ' ' + currency; }
  };
  var megabytes = function (bytes) { return Math.round(bytes / 1024 / 1024) + ' MB'; };
  var httpsOnly = function (url) { return typeof url === 'string' && /^https:\/\//.test(url) ? url : null; };
  /** Polish plural: 1 osoba, 2 osoby, 5 osób. */
  var pl = function (n, one, few, many) { return n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many; };
  var dayWord = function (n) { return n === 1 ? 'dzień' : 'dni'; };

  // Which page this is ('hammer-plus', 'kontakt' …) – the server writes it on <html>; a sign-in started here comes back here.
  var root = document.documentElement;
  var PAGE = root.getAttribute('data-page') || '';
  var params = new URLSearchParams(location.search);
  /** The address without what has been dealt with (?connected=1, ?invited=1 …) – a refresh does not repeat it. */
  function cleanAddress(names) {
    var left = new URLSearchParams(location.search);
    names.forEach(function (n) { left.delete(n); });
    var query = left.toString();
    history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
  }

  /**
   * What rarely changes is asked once in a while, not on every page: somebody clicking through the pages makes a few
   * calls, not a few per page (the server counts calls per address, and a whole school can sit behind one).
   */
  function remembered(key, minutes, load) {
    try {
      var hit = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (hit && Date.now() - hit.at < minutes * 60000) return Promise.resolve(hit.value);
    } catch (e) { /* private mode, a broken entry: just ask */ }
    return load().then(function (value) {
      try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), value: value })); } catch (e) { /* private mode */ }
      return value;
    });
  }

  var session = { user: null };
  var signedKnown = false; // the session has been asked
  var site = { discord: null, authReady: false }; // the Discord invite; is the Discord sign-in set up here
  var plus = { ready: false, plans: [], currency: 'eur', authReady: false };
  var chosen = null;
  var release; // the current installer: undefined until the feed answers, null when there is none yet

  // ── The download buttons ──
  // Downloading from the website needs a Discord sign-in (where the site has it set up) – the buttons say so; the
  // server sends a signed-out click through Discord and back to the start page with ?download=1, and that page starts
  // the download. #download is the start page's own button; [data-download] are the ones on the other pages.
  var mainDownload = $('download');
  var downloads = (mainDownload ? [mainDownload] : []).concat(all('[data-download]'));
  function showRelease() {
    if (release === undefined) return;
    var meta = $('download-meta');
    if (!release) {
      downloads.forEach(function (b) { b.textContent = 'Już wkrótce'; b.setAttribute('aria-disabled', 'true'); });
      if (meta) meta.textContent = 'Launcher jest w przygotowaniu – wersja beta pojawi się tutaj. Zajrzyj na naszego Discorda, damy znać.';
      return;
    }
    var label = signedKnown && !session.user && site.authReady ? 'Zaloguj przez Discord i pobierz' : 'Pobierz na Windows';
    downloads.forEach(function (b) { b.removeAttribute('aria-disabled'); b.textContent = label; });
    if (meta) meta.textContent = 'Wersja ' + release.version + ' (beta) · ' + megabytes(release.size) + ' · ' + new Date(release.date).toLocaleDateString('pl-PL');
    // The version in the hero's badge and in the facts strip – both stay hidden while there is no release.
    if ($('hero-version')) { $('hero-version').textContent = 'wersja ' + release.version; $('hero-version').hidden = false; }
    if ($('fact-version')) { $('fact-version-v').textContent = release.version; $('fact-version').hidden = false; }
    if ($('go-news')) $('go-news').textContent = 'Wersja ' + release.version + ' (beta) – zobacz, co nowego.';
  }
  var downloadsNow = function () { return Boolean(release && signedKnown && (session.user || !site.authReady)); };
  // Signed in (or no sign-in on this site): the click downloads right away – the page says it started.
  downloads.forEach(function (b) {
    b.addEventListener('click', function () {
      if (!downloadsNow()) return;
      if (b === mainDownload) $('download-started').hidden = false;
      else toast('Pobieranie się zaczęło… Nic się nie dzieje? Kliknij jeszcze raz.');
    });
  });
  /** Back from the Discord sign-in the download button asked for (the start page): the download starts by itself. */
  var downloadHandled = false;
  function downloadAfterSignIn() {
    if (!mainDownload || downloadHandled || params.get('download') !== '1' || release === undefined || !signedKnown) return;
    downloadHandled = true;
    var clean = function () { cleanAddress(['download', 'connected', 'joined', 'auth']); };
    if (params.get('auth')) {
      if (params.get('auth') === 'cancelled') toast('Logowanie anulowane – launcher pobierzesz ze strony po zalogowaniu przez Discord.', true);
      return clean();
    }
    if (!release || (!session.user && site.authReady)) return clean();
    $('download-started').hidden = false;
    clean();
    location.href = '/download';
  }

  // ── „Oficjalny start” (the start page): the server draws it; a page left open moves on by itself – „jutro” the next
  // day, „Startujemy dziś!” on the day (from its hour, when one is set), gone the day after. Polish time, the server's clock. ──
  (function () {
    var strip = $('launch');
    if (!strip) return;
    var date = strip.getAttribute('data-date');
    var time = strip.getAttribute('data-time') || '';
    var skew = (Number(strip.getAttribute('data-now')) || Date.now()) - Date.now();
    function polishNow() {
      var p = {};
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(Date.now() + skew)).forEach(function (x) { p[x.type] = x.value; });
      return { day: p.year + '-' + p.month + '-' + p.day, time: p.hour + ':' + p.minute };
    }
    var timer = setInterval(function () {
      var now = polishNow();
      var days = Math.round((Date.parse(date + 'T00:00Z') - Date.parse(now.day + 'T00:00Z')) / 86400000);
      if (days < 0) { strip.hidden = true; clearInterval(timer); return; }
      if (days === 0 && (!time || now.time >= time)) {
        if (strip.className === 'launch today') return;
        strip.className = 'launch today';
        strip.textContent = '';
        strip.appendChild(el('span', { class: 'launch-ico', 'aria-hidden': 'true', text: '🚀' }));
        strip.appendChild(el('span', { class: 'launch-text' }, [el('b', { text: 'Startujemy dziś!' })]));
        return;
      }
      var hour = time ? ' o ' + time : '';
      var when = strip.querySelector('.launch-when');
      if (when) when.textContent = days === 0 ? 'dziś' + hour : days === 1 ? 'jutro' + hour : 'za ' + days + ' dni';
    }, 60000);
  })();

  // ── Aktualności: the current version and what the admin panel published ──
  function showNews(feed) {
    var box = $('news');
    if (!box) return;
    var card = $('release-card');
    if (feed.release) {
      $('release-title').textContent = 'Hammer Launcher ' + feed.release.version + ' (beta)';
      $('release-date').textContent = new Date(feed.release.date).toLocaleDateString('pl-PL') + ' · ' + megabytes(feed.release.size);
      $('release-notes').textContent = feed.release.notes || '';
      $('release-notes').hidden = !feed.release.notes;
    }
    card.hidden = !feed.release;
    box.textContent = '';
    (feed.news || []).forEach(function (n) {
      var link = httpsOnly(n.url);
      var image = httpsOnly(n.image);
      box.appendChild(el('article', { class: 'card' + (n.pinned ? ' pinned' : '') }, [
        image ? el('img', { src: image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
        el('div', { class: 'row' }, [n.tag ? el('span', { class: 'pill', text: n.tag }) : null, n.pinned ? el('span', { class: 'pill gold', text: 'Przypięte' }) : null, el('span', { class: 'when right', text: n.date || '' })]),
        el('h2', { text: n.title }),
        n.body ? el('p', { text: n.body }) : null,
        link ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: 'Czytaj więcej →' }) : null,
      ]));
    });
    box.hidden = !box.children.length;
    $('news-empty').hidden = box.children.length > 0; // nothing published yet: the page says so instead of standing empty
  }

  // ── Hammer+ ──
  var signInHere = '/api/shop/auth/start?next=' + encodeURIComponent(PAGE);
  function showPlans() {
    var box = $('plans');
    box.textContent = '';
    if (!plus.ready) {
      box.appendChild(el('p', { class: 'notice', text: 'Hammer+ nie jest jeszcze w sprzedaży na stronie. Kod możesz dostać od naszego zespołu na Discordzie.' }));
      return;
    }
    plus.plans.forEach(function (plan) {
      // Buying needs a Discord sign-in (the code comes by DM, the 💎 Hammer+ role on the server) – the button says so.
      var buy = el('button', { class: 'btn gold', type: 'button', text: session.user ? 'Kup' : 'Zaloguj i kup', title: session.user ? '' : 'Najpierw zalogujesz się przez Discord' });
      buy.addEventListener('click', function () { choose(plan); });
      box.appendChild(el('div', { class: 'plan' }, [
        el('div', {}, [el('b', { text: plan.name }), el('div', { class: 'sub', text: plan.days ? plan.days + ' ' + dayWord(plan.days) + ' od zakupu' : 'Bez limitu czasu' })]),
        el('span', { class: 'price', text: money(plan.price, plus.currency) }),
        buy,
      ]));
    });
  }
  function choose(plan) {
    if (!session.user) {
      try { sessionStorage.setItem('hs_plan', plan.id); } catch (e) { /* private mode */ }
      location.href = signInHere;
      return;
    }
    chosen = plan;
    $('nick-plan').textContent = plan.name + ' – ' + money(plan.price, plus.currency);
    $('nick-error').hidden = true;
    $('nick-dialog').showModal();
    $('nick').focus();
  }
  function plusForm() {
    $('nick-cancel').addEventListener('click', function () { $('nick-dialog').close(); });
    $('nick-form').addEventListener('submit', function (event) {
      event.preventDefault();
      if (!chosen) return;
      var pay = $('nick-pay');
      var error = $('nick-error');
      pay.disabled = true;
      pay.textContent = 'Sprawdzam nick…';
      error.hidden = true;
      var requestId = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      post('/api/shop/checkout', { kind: 'plus', plan: chosen.id, nick: $('nick').value.trim(), requestId: requestId })
        .then(function (r) { location.href = r.url; })
        .catch(function (err) {
          error.textContent = err.message;
          error.hidden = false;
          pay.disabled = false;
          pay.textContent = 'Przejdź do płatności';
        });
    });
  }

  // ── Partnerzy: „Kopiuj IP” next to a partner's Minecraft address ──
  all('[data-copy]').forEach(function (button) {
    var label = button.textContent;
    var timer = null;
    button.addEventListener('click', function () {
      var value = button.getAttribute('data-copy');
      var done = function () {
        button.textContent = 'Skopiowano!';
        button.classList.add('copied');
        toast('Adres ' + value + ' skopiowany – wklej go w Minecrafcie: Tryb wieloosobowy → Dodaj serwer.');
        clearTimeout(timer);
        timer = setTimeout(function () { button.textContent = label; button.classList.remove('copied'); }, 2500);
      };
      var byHand = function () {
        // No clipboard (an old browser, a page that is not https): the address gets selected – Ctrl+C does the rest.
        var code = button.parentNode.querySelector('code');
        if (code && window.getSelection) { var range = document.createRange(); range.selectNodeContents(code); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
        toast('Zaznaczyliśmy adres – skopiuj go (Ctrl+C).', true);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, byHand);
      else byHand();
    });
  });

  function codeCard(order, fresh) {
    var p = order.plus || {};
    var until = p.until === 0 ? 'na zawsze' : p.until ? 'do ' + new Date(p.until).toLocaleDateString('pl-PL') : '';
    var copy = el('button', { class: 'btn small', type: 'button', text: 'Kopiuj kod' });
    copy.addEventListener('click', function () {
      navigator.clipboard.writeText(p.code).then(function () { toast('Kod skopiowany. Wklej go w launcherze: Hammer+ → „Mam kod”.'); }, function () { toast('Zaznacz kod i skopiuj go ręcznie (Ctrl+C).', true); });
    });
    return el('div', { class: 'code-card' }, [
      el('div', { class: 'row' }, [el('b', { text: (fresh ? 'Gotowe! ' : '') + 'Konto ' + (p.nick || '') }), until ? el('span', { class: 'pill gold', text: until }) : null, p.code ? copy : null]),
      p.code ? el('code', { class: 'code', text: p.code }) : el('p', { class: 'muted small', text: order.delivery || 'Kod wystawi nasz zespół – napisz do nas na Discordzie.' }),
      fresh ? el('p', { class: 'small soft', text: 'Otwórz Hammer Launcher → Hammer+ → „Mam kod” i wklej kod. Wysłaliśmy go też w wiadomości prywatnej na Discordzie.' }) : null,
      p.member === true && fresh ? el('p', { class: 'small soft', text: 'Na naszym Discordzie masz już rangę 💎 Hammer+.' }) : null,
      p.invite ? el('div', { class: 'row' }, [el('span', { class: 'small soft grow', text: 'Dołącz do naszego Discorda – po wejściu od razu dostaniesz rangę 💎 Hammer+.' }), el('a', { class: 'btn small', href: p.invite, target: '_blank', rel: 'noopener', text: 'Dołącz do Discorda' })]) : null,
    ]);
  }
  /**
   * „Twoje kody”: only the codes that still run – the one that runs the longest first (forever, then the latest end
   * date), because that is the one worth typing in. A code whose time is over opens nothing in the launcher – the
   * server marks such an order (expired) and it is not listed at all, so buying short plans does not make the page
   * longer and longer. More than a few: the rest waits behind „Pokaż wszystkie”.
   */
  var CODES_SHOWN = 3;
  function showCodes(freshId) {
    if (!session.user || !$('my-codes')) return Promise.resolve();
    return api('/api/shop/orders').then(function (r) {
      var mine = (r.orders || []).filter(function (o) { return o.kind === 'plus' && o.status === 'paid'; });
      var running = mine.filter(function (o) {
        var p = o.plus || {};
        return o.id !== freshId && !p.expired && !(p.until && p.until <= Date.now());
      });
      var ends = function (o) { var until = (o.plus || {}).until; return until === 0 ? Infinity : until || 0; }; // 0 = forever
      running.sort(function (a, b) { return ends(a) === ends(b) ? 0 : ends(b) > ends(a) ? 1 : -1; }); // equal ends keep the server's order: newest first
      var list = $('my-codes-list');
      var more = $('my-codes-more');
      list.textContent = '';
      running.forEach(function (o, i) {
        var card = codeCard(o, false);
        card.hidden = i >= CODES_SHOWN;
        list.appendChild(card);
      });
      var folded = running.length > CODES_SHOWN;
      more.hidden = !folded;
      more.textContent = 'Pokaż wszystkie (' + running.length + ')';
      more.setAttribute('aria-expanded', 'false');
      $('my-codes').hidden = !running.length;
      var fresh = mine.filter(function (o) { return o.id === freshId; })[0];
      if (fresh) {
        var box = $('plus-result');
        box.textContent = '';
        box.appendChild(codeCard(fresh, true));
        box.hidden = false;
        thanksPaid(fresh);
      }
      return fresh || null;
    }).catch(function () { return null; /* the list is a convenience */ });
  }
  function codesFold() {
    var more = $('my-codes-more');
    more.addEventListener('click', function () {
      var open = more.getAttribute('aria-expanded') !== 'true';
      var cards = Array.prototype.slice.call($('my-codes-list').children);
      cards.forEach(function (card, i) { card.hidden = !open && i >= CODES_SHOWN; });
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? 'Pokaż mniej' : 'Pokaż wszystkie (' + cards.length + ')';
    });
  }

  // ── „Dziękujemy za zakup!”: the screen Stripe sends the buyer back to – paid (the code, big, with a copy button),
  // still being processed, cancelled or failed. One <dialog> (Esc, the ×, a click beside it close it); the moving
  // parts are CSS only and stand still with prefers-reduced-motion.
  var thanksBox = $('thanks');
  var svgIcon = function (name) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    var use = document.createElementNS(ns, 'use');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  };
  /** The round mark on top: a tick, a clock, or a cross (drawn in CSS). */
  var thanksBadge = function (name) { return el('div', { class: 'thanks-badge' + (name ? '' : ' x'), 'aria-hidden': 'true' }, [name ? svgIcon(name) : null]); };
  function thanksShow(kind, children) {
    if (!thanksBox) return;
    thanksBox.className = 'thanks ' + kind;
    var body = $('thanks-body');
    body.textContent = '';
    children.forEach(function (c) { if (c) body.appendChild(c); });
    body.scrollTop = 0;
    if (!thanksBox.open) thanksBox.showModal();
    var first = body.querySelector('[data-focus]');
    if (first) first.focus();
  }
  function thanksClose() { if (thanksBox && thanksBox.open) thanksBox.close(); }
  /** Closes the screen and takes the visitor to a part of the page. */
  function thanksGo(id) {
    thanksClose();
    var target = $(id);
    if (target) target.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  }
  var thanksActions = function (buttons) { return el('div', { class: 'thanks-actions' }, buttons); };
  var thanksButton = function (cls, label, onClick, focus) {
    var b = el('button', { class: 'btn ' + cls, type: 'button', text: label });
    if (focus) b.setAttribute('data-focus', '');
    b.addEventListener('click', onClick);
    return b;
  };
  if (thanksBox) {
    $('thanks-close').addEventListener('click', thanksClose);
    // A click on the dim background (the dialog's own box, outside its content) closes it too.
    thanksBox.addEventListener('click', function (event) {
      if (event.target !== thanksBox) return;
      var r = thanksBox.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) thanksClose();
    });
  }

  function thanksWaiting() {
    thanksShow('waiting', [
      el('div', { class: 'thanks-spin', 'aria-hidden': 'true' }),
      el('h2', { id: 'thanks-h', text: 'Płatność się przetwarza…' }),
      el('p', { id: 'thanks-lead', class: 'soft', text: 'Stripe potwierdza Twoją płatność – zwykle trwa to kilka sekund. Nie zamykaj tej strony, kod pokaże się tutaj.' }),
    ]);
  }
  function thanksPending(retry) {
    thanksShow('pending', [
      thanksBadge('history'),
      el('h2', { id: 'thanks-h', text: 'Płatność jeszcze się przetwarza' }),
      el('p', { id: 'thanks-lead', class: 'soft', text: 'Stripe nie potwierdził jej od razu – czasem trwa to kilka minut. Gdy tylko przejdzie, kod pokaże się na tej stronie w „Twoje kody” i przyjdzie w wiadomości prywatnej na Discordzie.' }),
      thanksActions([thanksButton('primary', 'Sprawdź ponownie', retry, true), thanksButton('ghost', 'Zamknij', thanksClose)]),
    ]);
  }
  function thanksCancelled() {
    thanksShow('cancelled', [
      thanksBadge(null),
      el('h2', { id: 'thanks-h', text: 'Płatność anulowana' }),
      el('p', { id: 'thanks-lead', class: 'soft', text: 'Nic nie zostało pobrane. Plan możesz wybrać ponownie w każdej chwili.' }),
      thanksActions([thanksButton('gold', 'Wybierz plan', function () { thanksGo('plans'); }, true), thanksButton('ghost', 'Zamknij', thanksClose)]),
    ]);
  }
  function thanksFailed(message) {
    thanksShow('failed', [
      thanksBadge(null),
      el('h2', { id: 'thanks-h', text: message ? 'Nie udało się sprawdzić płatności' : 'Płatność nie przeszła' }),
      el('p', { id: 'thanks-lead', class: 'soft', text: message ? message + ' Jeśli zapłaciłeś, kod pojawi się w „Twoje kody” i w wiadomości prywatnej na Discordzie.' : 'Nic nie zostało pobrane. Spróbuj jeszcze raz – inną kartą albo przez Apple Pay lub Google Pay.' }),
      el('p', { class: 'muted small', text: 'Pieniądze zeszły z konta, a kodu nie ma? Otwórz ticket „Hammer+ i płatności” na naszym Discordzie.' }),
      thanksActions([thanksButton('gold', 'Wybierz plan', function () { thanksGo('plans'); }, true), thanksButton('ghost', 'Zamknij', thanksClose)]),
    ]);
  }
  /** Paid, but the order could not be read back just now – the code is on its way to „Twoje kody” and Discord. */
  function thanksPaidLater() {
    thanksShow('paid', [
      thanksBadge('check'),
      el('h2', { id: 'thanks-h', text: 'Dziękujemy za zakup!' }),
      el('p', { id: 'thanks-lead', class: 'soft', text: 'Płatność przeszła. Twój kod przyszedł w wiadomości prywatnej na Discordzie – odśwież stronę, a pokaże się też tutaj, w „Twoje kody”.' }),
      thanksActions([thanksButton('primary', 'Odśwież stronę', function () { location.reload(); }, true), thanksButton('ghost', 'Zamknij', thanksClose)]),
    ]);
  }

  /** Where else the code went: Discord DMs, the e-mail from the payment (masked) – a sentence (the address kept on one line), or []. */
  function thanksWhere(order) {
    var r = order.receipt || {};
    var dm = r.dm === true;
    var address = r.email ? el('span', { class: 'nowrap', text: r.email }) : null;
    if (address && r.state === 'sent') return ['Kod wysłaliśmy też ' + (dm ? 'w wiadomości prywatnej na Discordzie i ' : '') + 'na e\u2011mail ', address, '.'];
    if (address && r.state === 'sending') return [dm ? 'Kod wysłaliśmy też w wiadomości prywatnej na Discordzie, a e\u2011mail z kodem jest w drodze na ' : 'E\u2011mail z kodem jest już w drodze na ', address, '.'];
    if (dm) return ['Kod wysłaliśmy też w wiadomości prywatnej na Discordzie.'];
    if (r.dm === false) return ['Nie mogliśmy napisać do Ciebie na Discordzie (zamknięte wiadomości prywatne) – kod jest zawsze tutaj, w „Twoje kody”.'];
    return [];
  }

  function thanksPaid(order) {
    var p = order.plus || {};
    var until = p.until === 0 ? 'na zawsze' : p.until ? 'do ' + new Date(p.until).toLocaleDateString('pl-PL') : '—';
    var fact = function (k, v) { return el('div', {}, [el('dt', { text: k }), el('dd', { text: v })]); };
    var status = el('p', { class: 'thanks-status small', role: 'status' });
    var code = p.code ? el('code', { class: 'thanks-code', id: 'thanks-code', text: p.code }) : null;
    var copy = null;
    if (code) {
      copy = el('button', { class: 'btn primary big thanks-copy', type: 'button', 'data-focus': '' });
      var label = function (done) {
        copy.textContent = '';
        if (done) copy.appendChild(svgIcon('check'));
        copy.appendChild(document.createTextNode(done ? 'Skopiowano!' : 'Kopiuj kod'));
        copy.classList.toggle('copied', done);
      };
      var timer = null;
      var copied = function () {
        label(true);
        status.textContent = 'Kod skopiowany – wklej go w launcherze.';
        clearTimeout(timer);
        timer = setTimeout(function () { label(false); }, 2500);
      };
      // No clipboard (an old browser, a page that is not https): the code gets selected – Ctrl+C does the rest.
      var byHand = function () {
        var range = document.createRange();
        range.selectNodeContents(code);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        if (ok) copied();
        else status.textContent = 'Kod jest zaznaczony – skopiuj go skrótem Ctrl+C (na telefonie: przytrzymaj i wybierz Kopiuj).';
      };
      copy.addEventListener('click', function () {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(p.code).then(copied, byHand);
        else byHand();
      });
      label(false);
    }
    var where = thanksWhere(order);
    var mine = thanksButton('', 'Moje kody', function () { thanksGo('plus-result'); }, !code);
    var download = release ? el('a', { class: 'btn ghost', href: '/download', title: 'Nie masz jeszcze Hammer Launchera? Pobierz go za darmo.' }, [svgIcon('download'), 'Pobierz launcher']) : null;
    if (download) download.addEventListener('click', function () { status.textContent = 'Pobieranie się zaczęło… Nic się nie dzieje? Kliknij jeszcze raz.'; });
    thanksShow('paid', [
      thanksBadge('check'),
      el('h2', { id: 'thanks-h', text: 'Dziękujemy za zakup!' }),
      el('p', { id: 'thanks-lead', class: 'soft', text: code ? 'Hammer+ jest Twój. Oto kod do Hammer Launchera:' : 'Płatność przeszła. ' + (order.delivery || 'Kod wystawi nasz zespół – napisz do nas na Discordzie.') }),
      el('dl', { class: 'thanks-facts' }, [fact('Plan', p.plan || 'Hammer+'), fact('Konto Minecraft', p.nick || '—'), fact('Ważny', until)]),
      code ? el('div', { class: 'thanks-codebox' }, [code, copy]) : null,
      status,
      code ? el('ol', { class: 'thanks-steps' }, [
        el('li', {}, [el('span', {}, ['Otwórz ', el('b', { text: 'Hammer Launcher' }), ' → ', el('b', { text: 'Hammer+' })])]),
        el('li', {}, [el('span', {}, ['Kliknij ', el('b', { text: '„Mam kod”' }), ' i wklej kod'])]),
        el('li', {}, [el('span', {}, ['Kliknij ', el('b', { text: '„Aktywuj”' }), ' – gotowe!'])]),
      ]) : null,
      el('p', { class: 'thanks-note small' }, [code ? 'Kod działa tylko na koncie ' + (p.nick || '') + '. ' : ''].concat(where, [
        p.invite ? el('a', { href: p.invite, target: '_blank', rel: 'noopener', text: ' Dołącz do naszego Discorda – dostaniesz rangę 💎 Hammer+.' }) : null,
      ])),
      thanksActions([mine, download]),
    ]);
  }

  /**
   * Back from Stripe: is it paid? (Stripe can take a moment – asked a few times.) → true while a payment is being
   * checked: „Twoje kody” then comes with the answer, so the fresh code is never listed twice.
   */
  function afterPayment() {
    var sessionId = params.get('session_id');
    if (params.get('payment') === 'cancelled') {
      thanksCancelled();
      cleanAddress(['payment']);
    }
    if (params.get('payment') !== 'return' || !sessionId) return false;
    var box = $('plus-result');
    box.textContent = '';
    box.appendChild(el('p', { class: 'notice', text: 'Sprawdzam płatność…' }));
    box.hidden = false;
    thanksWaiting();
    var tries = 0;
    var check = function () {
      post('/api/shop/verify', { sessionId: sessionId }).then(function (r) {
        if (r.paid) return showCodes(r.order).then(function (fresh) { if (!fresh) thanksPaidLater(); });
        if (r.status === 'pending' && ++tries < 8) return setTimeout(check, 2000);
        box.textContent = '';
        if (r.status === 'pending') {
          box.appendChild(el('p', { class: 'notice warn', text: 'Płatność nie została jeszcze potwierdzona. Jeśli zapłaciłeś, odśwież stronę za chwilę – kod pojawi się tutaj i na Discordzie.' }));
          thanksPending(function () { tries = 0; thanksWaiting(); check(); });
        } else {
          box.appendChild(el('p', { class: 'notice bad', text: 'Płatność nie przeszła – nic nie zostało pobrane. Możesz spróbować ponownie.' }));
          thanksFailed(null);
        }
        return showCodes(null);
      }).catch(function (err) {
        box.textContent = '';
        box.appendChild(el('p', { class: 'notice bad', text: err.message }));
        thanksFailed(err.message);
        return showCodes(null);
      });
    };
    check();
    cleanAddress(['payment', 'session_id']);
    return true;
  }

  // ── „Zaproś znajomego”: the personal link, the numbers, the days to claim ──
  function rewardCard(reward, fresh) {
    var card = codeCard({ plus: { nick: reward.nick, until: reward.until, code: reward.code } }, fresh);
    card.insertBefore(el('span', { class: 'pill gold', text: fresh ? 'Odebrane z poleceń' : 'Kod z nagrody za polecenie' }), card.firstChild);
    return card;
  }
  function showReferrals(fresh) {
    return api('/api/shop/referrals').then(function (r) {
      $('ref-out').hidden = r.signedIn;
      $('ref-in').hidden = !r.signedIn;
      if (!r.signedIn) {
        $('ref-login').hidden = !r.authReady;
        if (!r.authReady) $('ref-out-text').textContent = 'Logowanie przez Discord nie jest jeszcze uruchomione – link polecający pojawi się tutaj wkrótce.';
        return;
      }
      $('ref-link').value = new URL(r.link, location.origin).href;
      var st = r.stats;
      [['invited', pl(st.invited, 'osoba', 'osoby', 'osób') + ' z Twojego linku'], ['downloaded', pl(st.downloaded, 'pobrała', 'pobrały', 'pobrało') + ' launcher'], ['bought', pl(st.bought, 'kupiła', 'kupiły', 'kupiło') + ' Hammer+'], ['earned', pl(st.earned, 'dzień zdobyty', 'dni zdobyte', 'dni zdobytych')]].forEach(function (x) {
        $('ref-' + x[0]).textContent = String(st[x[0]]);
        $('ref-' + x[0] + '-l').textContent = x[1];
      });
      $('ref-claim').hidden = !(st.balance > 0 && r.claimReady);
      $('ref-balance').textContent = 'Masz ' + st.balance + ' ' + dayWord(st.balance) + ' Hammer+ do odebrania! Wpisz swój nick z Minecrafta – kod zadziała na tym koncie.';
      var box = $('ref-result');
      if (fresh) return;
      box.textContent = '';
      if (r.latest && r.latest.code) box.appendChild(rewardCard(r.latest, false));
      box.hidden = !box.children.length;
    }).catch(function () { /* the card stays as it is */ });
  }
  function referralForm() {
    $('ref-copy').addEventListener('click', function () {
      var link = $('ref-link').value;
      navigator.clipboard.writeText(link).then(function () { toast('Link skopiowany – wyślij go znajomemu.'); }, function () { $('ref-link').select(); toast('Zaznaczyliśmy link – skopiuj go (Ctrl+C).', true); });
    });
    $('ref-claim').addEventListener('submit', function (event) {
      event.preventDefault();
      var button = $('ref-claim-btn');
      var error = $('ref-error');
      button.disabled = true;
      button.textContent = 'Sprawdzam nick…';
      error.hidden = true;
      post('/api/shop/referrals/claim', { nick: $('ref-nick').value.trim() })
        .then(function (r) {
          var box = $('ref-result');
          box.textContent = '';
          box.appendChild(rewardCard(r, true));
          box.hidden = false;
          $('ref-nick').value = '';
          toast('Gotowe! Kod Hammer+ dla konta ' + r.nick + ' jest poniżej i na Discordzie.');
          return showReferrals(true);
        })
        .catch(function (err) { error.textContent = err.message; error.hidden = false; })
        .then(function () { button.disabled = false; button.textContent = 'Odbierz'; });
    });
  }

  // ── Kontakt: the form goes to POST /api/shop/contact; the address and the topics come from GET /api/shop/contact ──
  function contactForm() {
    var form = $('contact-form');
    var done = $('contact-done');
    var error = $('contact-error');
    var button = $('contact-send');
    var field = { name: $('contact-name'), email: $('contact-email'), topic: $('contact-topic'), message: $('contact-message') };
    var sending = false;
    var pickTopic = function (id) { if (id && all('#contact-topic option').some(function (o) { return o.value === id; })) field.topic.value = id; };
    pickTopic(params.get('temat')); // links like /kontakt?temat=bug open the form on that topic
    api('/api/shop/contact').then(function (info) {
      if (info.email) {
        $('contact-mail').href = 'mailto:' + info.email;
        $('contact-mail-text').textContent = info.email;
        $('contact-mail').hidden = false;
      }
      if (!Array.isArray(info.topics) || !info.topics.length) return;
      var current = field.topic.value;
      field.topic.textContent = '';
      info.topics.forEach(function (t) { field.topic.appendChild(el('option', { value: String(t.id), text: String(t.label) })); });
      pickTopic(current);
    }).catch(function () { /* the form works with the topics it came with */ });

    var count = function () { $('contact-count').textContent = String(field.message.value.length); };
    field.message.addEventListener('input', count);
    count();
    /** The message under a field (in its label) – empty text takes it away. */
    function mark(input, text) {
      var label = input.closest('label');
      var note = label.querySelector('.field-error');
      if (!text) {
        if (note) note.remove();
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
        return;
      }
      if (!note) note = input.insertAdjacentElement('afterend', el('span', { class: 'field-error', id: input.id + '-error' })); // right under the field
      note.textContent = text;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', note.id);
    }
    Object.keys(field).forEach(function (k) { field[k].addEventListener('input', function () { mark(field[k], ''); }); });
    /** What is wrong with each field – the same limits the server has (it checks again anyway). */
    function problems() {
      var name = field.name.value.trim();
      var email = field.email.value.trim();
      var message = field.message.value.trim();
      return {
        name: name.length < 2 ? 'Podaj imię albo nick – co najmniej 2 znaki.' : name.length > 60 ? 'Imię albo nick może mieć najwyżej 60 znaków.' : '',
        email: !email ? 'Podaj swój e-mail – na niego odpiszemy.' : email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? 'Ten adres e-mail wygląda na niepoprawny – sprawdź go.' : '',
        topic: field.topic.value ? '' : 'Wybierz temat wiadomości.',
        message: message.length < 10 ? 'Napisz trochę więcej – co najmniej 10 znaków.' : message.length > 2000 ? 'Wiadomość może mieć najwyżej 2000 znaków.' : '',
      };
    }
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (sending) return; // one message per click, however fast the clicks are
      var wrong = problems();
      var first = null;
      Object.keys(field).forEach(function (k) {
        mark(field[k], wrong[k]);
        if (wrong[k] && !first) first = field[k];
      });
      error.hidden = true;
      if (first) return first.focus();
      sending = true;
      button.disabled = true;
      button.querySelector('span').textContent = 'Wysyłam…';
      var email = field.email.value.trim();
      post('/api/shop/contact', { name: field.name.value.trim(), email: email, topic: field.topic.value, message: field.message.value.trim(), website: $('contact-website').value })
        .then(function () {
          $('contact-done-mail').textContent = email;
          form.hidden = true;
          done.hidden = false;
          done.focus();
        })
        .catch(function (err) { error.textContent = err.message; error.hidden = false; }) // the server's own sentence, as it is
        .then(function () {
          sending = false;
          button.disabled = false;
          button.querySelector('span').textContent = 'Wyślij wiadomość';
        });
    });
    $('contact-again').addEventListener('click', function () {
      field.message.value = '';
      count();
      done.hidden = true;
      form.hidden = false;
      field.message.focus();
    });
  }
  /** Signed in: the form starts with the Discord name (the visitor can change it). */
  function contactName() {
    var input = $('contact-name');
    if (input && session.user && !input.value) input.value = String(session.user.name || session.user.username || '').slice(0, 60);
  }

  // ── Start ──
  function showUser() {
    var who = $('who');
    if (!session.user) {
      $('login').hidden = !site.authReady;
      return;
    }
    who.textContent = '';
    if (session.user.avatar) who.appendChild(el('img', { src: session.user.avatar, alt: '', referrerpolicy: 'no-referrer' }));
    who.appendChild(el('span', { text: session.user.name || session.user.username || '' }));
  }
  if (params.get('auth') === 'failed') toast('Logowanie przez Discord nie powiodło się. Spróbuj ponownie.', true);
  if (params.get('auth') === 'unavailable') toast('Logowanie przez Discord nie jest jeszcze uruchomione.', true);
  if (params.get('auth') === 'cancelled' && params.get('download') !== '1') toast('Logowanie przez Discord anulowane.', true);
  if (params.get('download') === 'none') toast('Launcher nie jest jeszcze dostępny do pobrania – już wkrótce!');
  if (params.get('invited') && $('invited')) $('invited').hidden = false;
  // (?download=1 stays until the download has started – downloadAfterSignIn; ?payment=… until afterPayment has read it)
  var dealtWith = ['auth', 'connected', 'joined', 'invited'].concat(params.get('download') === 'none' ? ['download'] : []).filter(function (n) { return params.has(n); });
  if (dealtWith.length && params.get('download') !== '1') cleanAddress(dealtWith);

  if ($('plans')) { plusForm(); codesFold(); }
  if ($('ref-out')) referralForm();
  if ($('contact-form')) contactForm();

  // The installer and the news: only where a page shows them (a download button, the news, the version).
  if (downloads.length || $('news')) {
    var loadFeed = function () { return api('/api/launcher/news'); };
    ($('news') ? loadFeed() : remembered('hs_feed', 3, loadFeed)).then(function (feed) {
      release = feed.release || null;
      showRelease();
      downloadAfterSignIn();
      showNews(feed);
    }).catch(function () {
      release = null;
      showRelease();
      showNews({ release: null, news: [] });
    });
  }
  // The Discord invite and whether sign-in is set up: the same on every page.
  var siteInfo = remembered('hs_site', 10, function () {
    return api('/api/shop/store').then(function (store) { return { discord: httpsOnly(store.discordUrl), authReady: Boolean(store.authReady) }; });
  }).catch(function () { return site; });
  siteInfo.then(function (info) {
    if (info.discord) all('[data-discord]').forEach(function (a) { a.href = info.discord; a.hidden = false; });
  });
  var asked = [api('/api/shop/session').catch(function () { return { user: null }; }), siteInfo];
  if ($('plans')) asked.push(api('/api/shop/plus').catch(function () { return plus; }));
  Promise.all(asked).then(function (r) {
    session = r[0];
    site = r[1];
    signedKnown = true;
    showUser();
    showRelease();
    downloadAfterSignIn();
    contactName();
    if ($('ref-out')) showReferrals();
    if (!$('plans')) return;
    plus = r[2];
    showPlans();
    if (!afterPayment()) showCodes(null);
    // Signed in because of a "Kup" click → carry on with that plan.
    var wanted = null;
    try { wanted = sessionStorage.getItem('hs_plan'); sessionStorage.removeItem('hs_plan'); } catch (e) { /* private mode */ }
    var plan = wanted && session.user && plus.plans.filter(function (p) { return p.id === wanted; })[0];
    if (plan && params.get('connected')) choose(plan);
  });

  // ── The look: the header, the menu on small screens, scroll reveal, clips, tabs, 3D, themes ──
  var calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var mouse = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
  var bar = $('top');
  var onScroll = function () { bar.classList.toggle('scrolled', window.scrollY > 8); };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  var nav = $('nav');
  var toggle = $('nav-toggle');
  function menu(open) {
    bar.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('.sr-only').textContent = open ? 'Zamknij menu' : 'Menu';
  }
  toggle.addEventListener('click', function () { menu(!bar.classList.contains('menu-open')); });
  nav.addEventListener('click', function (event) { if (event.target.closest('a')) menu(false); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && bar.classList.contains('menu-open')) { menu(false); toggle.focus(); }
  });
  document.addEventListener('click', function (event) { if (bar.classList.contains('menu-open') && !bar.contains(event.target)) menu(false); });

  var watch = 'IntersectionObserver' in window;
  // Parts of a page ease in as they come into view; once settled, the classes go (so they never fight hover or tilt).
  if (watch && !calm && all('.reveal').length) {
    root.classList.add('reveal-on');
    var shown = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var node = entry.target;
        node.classList.add('in');
        shown.unobserve(node);
        setTimeout(function () { node.classList.remove('reveal', 'in'); }, 1200);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    all('.reveal').forEach(function (node) { shown.observe(node); });
  }

  // ── The clips: muted looping videos that play only while on screen (and in the open tab), never with less motion ──
  var clips = all('video.clip');
  var seen = new Map();
  function syncClips() {
    clips.forEach(function (video) {
      var panel = video.closest('.tabpanel');
      var hiddenTab = panel && document.querySelector('[data-tabs].tabs-ready') && !panel.classList.contains('is-active');
      var part = video.closest('.part');
      var hiddenPart = part && root.hasAttribute('data-part') && root.getAttribute('data-part') !== part.id; // a part of Funkcje that is not shown
      var go = !calm && !document.hidden && seen.get(video) && !hiddenTab && !hiddenPart && !video.userPaused;
      if (go && video.paused) {
        var playing = video.play();
        if (playing && playing.catch) playing.catch(function () { /* autoplay refused – the poster stays */ });
      } else if (!go && !video.paused) video.pause();
    });
  }
  if (clips.length) {
    clips.forEach(function (video) {
      var button = video.parentNode.querySelector('.clip-toggle');
      if (!button || calm) return;
      button.hidden = false;
      button.addEventListener('click', function () {
        video.userPaused = !video.userPaused;
        button.classList.toggle('paused', video.userPaused);
        button.querySelector('.sr-only').textContent = video.userPaused ? 'Odtwórz nagranie' : 'Zatrzymaj nagranie';
        syncClips();
      });
    });
    // The posters (first frames) come only when a clip is near – a browser fetches a poster at once otherwise.
    var posterOf = function (video) { if (!video.poster && video.getAttribute('data-poster')) video.poster = video.getAttribute('data-poster'); };
    if (watch) {
      var near = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) { if (entry.isIntersecting) { posterOf(entry.target); near.unobserve(entry.target); } });
      }, { rootMargin: '300px 0px' });
      var onScreen = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) { seen.set(entry.target, entry.isIntersecting); });
        syncClips();
      }, { threshold: 0.3 });
      clips.forEach(function (video) { near.observe(video); onScreen.observe(video); });
      document.addEventListener('visibilitychange', syncClips);
    } else clips.forEach(posterOf);
  }

  // Tabs (the features): arrows, Home and End move between them, as in any tab list.
  all('[data-tabs]').forEach(function (box) {
    var tabs = Array.prototype.slice.call(box.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        $(t.getAttribute('aria-controls')).classList.toggle('is-active', on);
      });
      if (focus) tab.focus();
      syncClips();
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { select(tab, false); });
      tab.addEventListener('keydown', function (event) {
        var next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        select(tabs[(next + tabs.length) % tabs.length], true);
      });
    });
    box.classList.add('tabs-ready');
    syncClips();
  });

  // ── Funkcje: one page, three parts (Launcher, Hammer Client, Wygląd) – one shown at a time ──
  // launcher-head.js has written the part the address names on <html data-part> before the first paint (launcher.css
  // hides the other two). Here the switcher becomes a tab list (arrows, Home, End), the address follows the part
  // (/funkcje#hammer-client, #wyglad – so Back, Forward and a shared link work) and a link to something inside
  // another part opens that part first.
  var partTabs = all('.part-tab');
  if (partTabs.length && root.hasAttribute('data-part')) {
    var parts = partTabs.map(function (tab) { return $(tab.getAttribute('href').slice(1)); });
    /** The part an id belongs to – the part itself or the one that holds that element; the first part for anything else. */
    var partOf = function (id) {
      var target = id ? $(id) : null;
      var part = target && target.closest('.part');
      return part && parts.indexOf(part) >= 0 ? part : parts[0];
    };
    var showPart = function (part) {
      root.setAttribute('data-part', part.id);
      partTabs.forEach(function (tab, i) {
        var on = parts[i] === part;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
      });
      try { sessionStorage.setItem('hs_part', part.id); } catch (e) { /* private mode */ } // a sign-in started here comes back to this part
      syncClips();
    };
    /**
     * Where the page stands after a part has been opened: at its top (target null), or at something inside the part.
     * At once – another part is like another page, and the site's smooth scrolling would glide over content that has
     * just been swapped (and gets cut short by it).
     */
    var jumpTo = function (target) {
      try {
        if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' });
        else window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      } catch (e) { // a browser that does not know these options
        if (target) target.scrollIntoView();
        else window.scrollTo(0, 0);
      }
    };
    /** The address of a part (the first one is the page itself) or of something inside one. */
    var addressOf = function (part, id) { return location.pathname + location.search + (id === part.id && part === parts[0] ? '' : '#' + id); };
    $('parts').setAttribute('role', 'tablist');
    partTabs.forEach(function (tab, i) {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', parts[i].id);
      parts[i].setAttribute('role', 'tabpanel');
      parts[i].setAttribute('aria-labelledby', tab.id);
      tab.addEventListener('keydown', function (event) {
        if (event.key === ' ') { event.preventDefault(); return tab.click(); } // a tab answers to Space like a button
        var next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: parts.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        next = (next + parts.length) % parts.length;
        history.replaceState(null, '', addressOf(parts[next], parts[next].id));
        showPart(parts[next]);
        partTabs[next].focus();
      });
    });
    // A click on the switcher, or on any link of this page that leads into a part („Zobacz Hammer Client”, the footer).
    document.addEventListener('click', function (event) {
      var link = event.target.closest ? event.target.closest('a[href*="#"]') : null;
      if (!link || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.pathname !== location.pathname || link.search !== location.search || link.target === '_blank') return;
      var id = link.hash.slice(1);
      var target = id ? $(id) : null;
      var part = target && target.closest('.part');
      if (!part || parts.indexOf(part) < 0) return;
      event.preventDefault();
      var address = addressOf(part, id);
      if (address !== location.pathname + location.search + location.hash) history.pushState(null, '', address); // (a click on the open part adds no step)
      showPart(part);
      if (target !== part) return jumpTo(target);
      if (partTabs.indexOf(link) >= 0) return; // the switcher itself: the page stays where it is
      jumpTo(null); // from further down the page: up to the switcher and the start of the part
      partTabs[parts.indexOf(part)].focus({ preventScroll: true });
    });
    // Back, Forward, or a # typed into the address (a browser tells about each with popstate, hashchange or both): the
    // part the address names now. Where the page stands is the browser's business – it restores the place on Back and
    // Forward and goes to what a new # names – except for something inside a part that was closed until now: it was
    // not on the screen for the browser to go to.
    var follow = function () {
      var id = location.hash.slice(1);
      var target = id ? $(id) : null;
      var part = partOf(id);
      var changed = root.getAttribute('data-part') !== part.id;
      showPart(part);
      if (changed && target && target !== part) jumpTo(target);
    };
    window.addEventListener('popstate', follow);
    window.addEventListener('hashchange', follow);
    // The start: what the head script chose (it knows the three parts), or the part that holds what the # names.
    var startId = location.hash.slice(1);
    var startPart = startId ? partOf(startId) : $(root.getAttribute('data-part')) || parts[0];
    showPart(startPart);
    if (!startId && startPart !== parts[0]) history.replaceState(null, '', addressOf(startPart, startPart.id)); // (back from a sign-in on that part)
    if (startId && $(startId) && $(startId) !== startPart && startPart !== parts[0]) jumpTo($(startId));
  }

  // ── 3D: the app in the hero follows the mouse and lifts with the scroll; cards tilt toward the mouse ──
  var stage = $('stage-3d');
  var hero = stage && stage.closest('.hero');
  if (stage && !calm) {
    var frame = 0;
    var shot = stage.querySelector('.stage-shot');
    var aim = function (x, y) {
      var r = stage.getBoundingClientRect();
      var dx = Math.max(-1, Math.min(1, (x - (r.left + r.width / 2)) / (r.width / 1.2)));
      var dy = Math.max(-1, Math.min(1, (y - (r.top + r.height / 2)) / (r.height / 1.2)));
      stage.style.setProperty('--ty', (dx * 9).toFixed(2) + 'deg');
      stage.style.setProperty('--tx', (-dy * 6).toFixed(2) + 'deg');
      var s = shot.getBoundingClientRect();
      shot.style.setProperty('--mx', ((x - s.left) / s.width * 100).toFixed(1) + '%');
      shot.style.setProperty('--my', ((y - s.top) / s.height * 100).toFixed(1) + '%');
      shot.style.setProperty('--shine', '1');
    };
    if (mouse) {
      hero.addEventListener('pointermove', function (event) {
        var x = event.clientX;
        var y = event.clientY;
        stage.classList.add('tilting');
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(function () { aim(x, y); });
      });
      hero.addEventListener('pointerleave', function () {
        cancelAnimationFrame(frame);
        stage.classList.remove('tilting');
        stage.style.setProperty('--ty', '0deg');
        stage.style.setProperty('--tx', '0deg');
        shot.style.setProperty('--shine', '.5');
      });
    }
    // The scroll lifts the app and lets the blocks float up at their own speeds (only while the hero is on screen).
    var ticking = false;
    var lift = function () {
      ticking = false;
      var h = hero.offsetHeight || 1;
      var p = Math.max(0, Math.min(1, window.scrollY / h));
      hero.style.setProperty('--sp', p.toFixed(3));
    };
    window.addEventListener('scroll', function () {
      if (ticking || window.scrollY > hero.offsetHeight * 1.2) return;
      ticking = true;
      requestAnimationFrame(lift);
    }, { passive: true });
    lift();
  }
  if (mouse && !calm) {
    var tiltOn = function (node, max) {
      node.classList.add('tilt');
      var frame = 0;
      node.addEventListener('pointermove', function (event) {
        var x = event.clientX;
        var y = event.clientY;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(function () {
          var r = node.getBoundingClientRect();
          var px = (x - r.left) / r.width;
          var py = (y - r.top) / r.height;
          node.classList.add('tilting');
          node.style.setProperty('--ry', ((px - 0.5) * max).toFixed(2) + 'deg');
          node.style.setProperty('--rx', ((0.5 - py) * max).toFixed(2) + 'deg');
          node.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
          node.style.setProperty('--my', (py * 100).toFixed(1) + '%');
        });
      });
      node.addEventListener('pointerleave', function () {
        cancelAnimationFrame(frame);
        node.classList.remove('tilting');
        node.style.setProperty('--ry', '0deg');
        node.style.setProperty('--rx', '0deg');
      });
    };
    all('.tile, .client-list li, .step, .cosm-card, .collab-cards .card, .go-card, .plus-how li, .shop-list li').forEach(function (node) { tiltOn(node, 9); });
    all('.tabpanel .shot, .live-card .shot, .client-shot').forEach(function (node) { tiltOn(node, 5); });
  }

  // ── „Wygląd po Twojemu”: a 3D deck of the launcher's themes – the chosen one in front, the rest turned away ──
  var deck = $('theme-deck');
  if (deck) {
    var THEMES = {
      domyslny: ['Domyślny', 'Ciepły pomarańcz Hammera – za darmo dla każdego.'],
      nether: ['Nether', 'Lawa, żar i popiół w ruchomym tle.'],
      end: ['End', 'Fiolet pustki, gwiazdy i blask prętów Endu.'],
      ocean: ['Ocean', 'Pryzmaryn, bąbelki i światło z góry.'],
      wisnia: ['Wiśniowy gaj', 'Różowe barwy i spadające płatki wiśni.'],
      mrok: ['Głęboki mrok', 'Pulsujący sculk prosto z głębin.'],
    };
    var picks = all('.theme-pick');
    var cards = Array.prototype.slice.call(deck.querySelectorAll('.theme-card'));
    var showTheme = function (id) {
      var info = THEMES[id];
      if (!info) return;
      var at = cards.map(function (c) { return c.getAttribute('data-theme'); }).indexOf(id);
      var narrow = window.innerWidth < 640;
      var n = cards.length;
      cards.forEach(function (card, i) {
        var d = (((i - at) % n) + n) % n; // the deck goes round: there are always themes on both sides
        if (d > n / 2) d -= n;
        var far = Math.abs(d);
        card.style.setProperty('--tx', (d * (narrow ? 62 : 46)) + '%');
        card.style.setProperty('--tz', (-far * (narrow ? 260 : 210)) + 'px');
        card.style.setProperty('--ry', (Math.sign(d) * Math.min(far, 2) * -24) + 'deg');
        card.style.setProperty('--o', far > 2 ? '0' : String(1 - far * 0.18));
        card.style.setProperty('--dim', String(Math.min(0.6, far * 0.32)));
        card.style.setProperty('--z', String(10 - far));
        card.setAttribute('aria-hidden', String(d !== 0));
      });
      picks.forEach(function (p) { p.setAttribute('aria-pressed', String(p.getAttribute('data-theme') === id)); });
      $('theme-stage').setAttribute('data-theme', id);
      var caption = $('theme-caption');
      caption.textContent = '';
      caption.appendChild(el('b', { text: info[0] }));
      caption.appendChild(document.createTextNode(' ' + info[1]));
    };
    deck.classList.add('deck-ready');
    picks.forEach(function (pick) { pick.addEventListener('click', function () { showTheme(pick.getAttribute('data-theme')); }); });
    cards.forEach(function (card) { card.addEventListener('click', function () { showTheme(card.getAttribute('data-theme')); }); });
    var current = function () { return (picks.filter(function (p) { return p.getAttribute('aria-pressed') === 'true'; })[0] || picks[0]).getAttribute('data-theme'); };
    window.addEventListener('resize', function () { showTheme(current()); });
    showTheme('domyslny');
  }
})();
