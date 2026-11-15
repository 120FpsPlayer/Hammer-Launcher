/* The launcher page: the download button (after a Discord sign-in), the news the admin panel published, Hammer+ bought
   by card and „Zaproś znajomego” – the referral card. At the end: the look (the menu on small screens, the section in
   view, scroll reveal, the feature tabs and the theme picker). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
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
  var params = new URLSearchParams(location.search);
  var session = { user: null };
  var plus = { ready: false, plans: [], currency: 'eur', authReady: false };
  var chosen = null;
  var release; // the current installer: undefined until the feed answers, null when there is none yet
  var signedKnown = false; // the session has been asked
  /** Polish plural: 1 osoba, 2 osoby, 5 osób. */
  var pl = function (n, one, few, many) { return n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many; };
  var dayWord = function (n) { return n === 1 ? 'dzień' : 'dni'; };

  // ── The download button and the news ──
  // Downloading from the website needs a Discord sign-in (where the site has it set up) – the button says so; the
  // server sends a signed-out click through Discord and back here with ?download=1, and the page starts the download.
  // The other download buttons further down the page ([data-download]) say the same as the one at the top.
  var mirrors = Array.prototype.slice.call(document.querySelectorAll('[data-download]'));
  function showRelease() {
    var button = $('download');
    var meta = $('download-meta');
    if (release === undefined) return;
    if (!release) {
      [button].concat(mirrors).forEach(function (b) { b.textContent = 'Już wkrótce'; b.setAttribute('aria-disabled', 'true'); });
      meta.textContent = 'Launcher jest w przygotowaniu – wersja beta pojawi się tutaj. Zajrzyj na naszego Discorda, damy znać.';
      return;
    }
    var label = signedKnown && !session.user && plus.authReady ? 'Zaloguj przez Discord i pobierz' : 'Pobierz na Windows';
    [button].concat(mirrors).forEach(function (b) { b.removeAttribute('aria-disabled'); b.textContent = label; });
    meta.textContent = 'Wersja ' + release.version + ' (beta) · ' + megabytes(release.size) + ' · ' + new Date(release.date).toLocaleDateString('pl-PL');
    // The version in the hero's badge and in the facts strip – both stay hidden while there is no release.
    $('hero-version').textContent = 'wersja ' + release.version;
    $('hero-version').hidden = false;
    $('fact-version-v').textContent = release.version;
    $('fact-version').hidden = false;
  }
  var downloadsNow = function () { return Boolean(release && signedKnown && (session.user || !plus.authReady)); };
  // Signed in (or no sign-in on this site): the click downloads right away – the page says it started.
  $('download').addEventListener('click', function () {
    if (downloadsNow()) $('download-started').hidden = false;
  });
  mirrors.forEach(function (b) {
    b.addEventListener('click', function () { if (downloadsNow()) toast('Pobieranie się zaczęło… Nic się nie dzieje? Kliknij jeszcze raz.'); });
  });
  /** Back from the Discord sign-in the download button asked for: the download starts by itself. */
  var downloadHandled = false;
  function downloadAfterSignIn() {
    if (downloadHandled || params.get('download') !== '1' || release === undefined || !signedKnown) return;
    downloadHandled = true;
    var clean = function () { history.replaceState(null, '', location.pathname + location.hash); };
    if (params.get('auth')) {
      if (params.get('auth') === 'cancelled') toast('Logowanie anulowane – launcher pobierzesz ze strony po zalogowaniu przez Discord.', true);
      return clean();
    }
    if (!release || (!session.user && plus.authReady)) return clean();
    $('download-started').hidden = false;
    clean();
    location.href = '/download';
  }
  function showNews(news) {
    var box = $('news');
    box.textContent = '';
    (news || []).slice(0, 6).forEach(function (n) {
      var title = el('h3', { text: n.title });
      var link = httpsOnly(n.url);
      var image = httpsOnly(n.image);
      box.appendChild(el('article', { class: 'card' + (n.pinned ? ' pinned' : '') }, [
        image ? el('img', { src: image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
        el('div', { class: 'row' }, [n.tag ? el('span', { class: 'pill', text: n.tag }) : null, n.pinned ? el('span', { class: 'pill gold', text: 'Przypięte' }) : null, el('span', { class: 'when right', text: n.date || '' })]),
        title,
        n.body ? el('p', { text: n.body }) : null,
        link ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: 'Czytaj więcej →' }) : null,
      ]));
    });
    $('aktualnosci').hidden = !box.children.length;
  }

  // ── Hammer+ ──
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
        el('div', {}, [el('b', { text: plan.name }), el('div', { class: 'sub', text: plan.days ? plan.days + ' dni od zakupu' : 'Bez limitu czasu' })]),
        el('span', { class: 'price', text: money(plan.price, plus.currency) }),
        buy,
      ]));
    });
  }
  function choose(plan) {
    if (!session.user) {
      try { sessionStorage.setItem('hs_plan', plan.id); } catch (e) { /* private mode */ }
      location.href = '/api/shop/auth/start?next=launcher';
      return;
    }
    chosen = plan;
    $('nick-plan').textContent = plan.name + ' – ' + money(plan.price, plus.currency);
    $('nick-error').hidden = true;
    $('nick-dialog').showModal();
    $('nick').focus();
  }
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
  function showCodes(freshId) {
    if (!session.user) return Promise.resolve();
    return api('/api/shop/orders').then(function (r) {
      var mine = (r.orders || []).filter(function (o) { return o.kind === 'plus' && o.status === 'paid'; });
      var list = $('my-codes-list');
      list.textContent = '';
      mine.forEach(function (o) { if (o.id !== freshId) list.appendChild(codeCard(o, false)); });
      $('my-codes').hidden = !list.children.length;
      var fresh = mine.filter(function (o) { return o.id === freshId; })[0];
      if (fresh) {
        var box = $('plus-result');
        box.textContent = '';
        box.appendChild(codeCard(fresh, true));
        box.hidden = false;
      }
    }).catch(function () { /* the list is a convenience */ });
  }

  /** Back from Stripe: is it paid? (Stripe can take a moment – asked a few times.) */
  function afterPayment() {
    var sessionId = params.get('session_id');
    if (params.get('payment') === 'cancelled') toast('Płatność anulowana – nic nie zostało pobrane.');
    if (params.get('payment') !== 'return' || !sessionId) return;
    var box = $('plus-result');
    box.textContent = '';
    box.appendChild(el('p', { class: 'notice', text: 'Sprawdzam płatność…' }));
    box.hidden = false;
    location.hash = '#plus';
    var tries = 0;
    (function check() {
      post('/api/shop/verify', { sessionId: sessionId }).then(function (r) {
        if (r.paid) return showCodes(r.order);
        if (r.status === 'pending' && ++tries < 8) return setTimeout(check, 2000);
        box.textContent = '';
        box.appendChild(el('p', { class: 'notice warn', text: 'Płatność nie została jeszcze potwierdzona. Jeśli zapłaciłeś, odśwież stronę za chwilę – kod pojawi się tutaj i na Discordzie.' }));
      }).catch(function (err) {
        box.textContent = '';
        box.appendChild(el('p', { class: 'notice bad', text: err.message }));
      });
    })();
    history.replaceState(null, '', '/launcher#plus');
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

  // ── Start ──
  function showUser() {
    var who = $('who');
    if (!session.user) {
      $('login').hidden = !plus.authReady;
      return;
    }
    who.textContent = '';
    if (session.user.avatar) who.appendChild(el('img', { src: session.user.avatar, alt: '', referrerpolicy: 'no-referrer' }));
    who.appendChild(el('span', { text: session.user.name || session.user.username || '' }));
  }
  if (params.get('auth') === 'failed') toast('Logowanie przez Discord nie powiodło się. Spróbuj ponownie.', true);
  if (params.get('auth') === 'unavailable') toast('Logowanie przez Discord nie jest jeszcze uruchomione.', true);
  if (params.get('download') === 'none') toast('Launcher nie jest jeszcze dostępny do pobrania – już wkrótce!');
  if (params.get('invited')) {
    $('invited').hidden = false;
    history.replaceState(null, '', location.pathname + location.hash);
  }

  api('/api/launcher/news').then(function (feed) { release = feed.release || null; showRelease(); downloadAfterSignIn(); showNews(feed.news); }).catch(function () { release = null; showRelease(); });
  api('/api/shop/store').then(function (store) {
    var invite = httpsOnly(store.discordUrl);
    if (invite) {
      [$('nav-discord')].concat(Array.prototype.slice.call(document.querySelectorAll('[data-discord]'))).forEach(function (a) { a.href = invite; a.hidden = false; });
    }
  }).catch(function () {});
  Promise.all([api('/api/shop/session').catch(function () { return { user: null }; }), api('/api/shop/plus').catch(function () { return plus; })]).then(function (r) {
    session = r[0];
    plus = r[1];
    signedKnown = true;
    showRelease();
    downloadAfterSignIn();
    showReferrals();
    showUser();
    showPlans();
    afterPayment();
    showCodes(null);
    // Signed in because of a "Kup" click → carry on with that plan.
    var wanted = null;
    try { wanted = sessionStorage.getItem('hs_plan'); sessionStorage.removeItem('hs_plan'); } catch (e) { /* private mode */ }
    var plan = wanted && session.user && plus.plans.filter(function (p) { return p.id === wanted; })[0];
    if (plan && params.get('connected')) { location.hash = '#plus'; choose(plan); }
  });

  // ── The look: the header, the menu on small screens, the section in view, scroll reveal, tabs, 3D, themes, clips ──
  var calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var mouse = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
  var each = function (selector, fn) { Array.prototype.forEach.call(document.querySelectorAll(selector), fn); };
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
  if (watch) {
    // The link of the section in the middle of the screen is lit.
    var links = {};
    Array.prototype.forEach.call(nav.querySelectorAll('a[href^="#"]'), function (a) { if (a.getAttribute('href').length > 1) links[a.getAttribute('href').slice(1)] = a; });
    var inView = {};
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { inView[entry.target.id] = entry.isIntersecting; });
      Object.keys(links).forEach(function (id) { links[id].classList.toggle('is-active', Boolean(inView[id])); });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(links).forEach(function (id) { if ($(id)) spy.observe($(id)); });
    // Sections ease in as they come into view; once settled, the classes go (so they never fight hover or tilt).
    if (!calm) {
      document.documentElement.classList.add('reveal-on');
      var shown = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var node = entry.target;
          node.classList.add('in');
          shown.unobserve(node);
          setTimeout(function () { node.classList.remove('reveal', 'in'); }, 1200);
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
      each('.reveal', function (node) { shown.observe(node); });
    }
  }

  // ── The clips: muted looping videos that play only while on screen (and in the open tab), never with less motion ──
  var clips = Array.prototype.slice.call(document.querySelectorAll('video.clip'));
  var seen = new Map();
  function syncClips() {
    clips.forEach(function (video) {
      var panel = video.closest('.tabpanel');
      var hiddenTab = panel && document.querySelector('[data-tabs].tabs-ready') && !panel.classList.contains('is-active');
      var go = !calm && !document.hidden && seen.get(video) && !hiddenTab && !video.userPaused;
      if (go && video.paused) {
        var playing = video.play();
        if (playing && playing.catch) playing.catch(function () { /* autoplay refused – the poster stays */ });
      } else if (!go && !video.paused) video.pause();
    });
  }
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
    clips.forEach(function (video) { near.observe(video); });
  } else clips.forEach(posterOf);
  if (watch) {
    var onScreen = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { seen.set(entry.target, entry.isIntersecting); });
      syncClips();
    }, { threshold: 0.3 });
    clips.forEach(function (video) { onScreen.observe(video); });
    document.addEventListener('visibilitychange', syncClips);
  }

  // Tabs (the features): arrows, Home and End move between them, as in any tab list.
  each('[data-tabs]', function (box) {
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
    each('.tile, .client-list li, .step, .cosm-card, .collab-cards .card', function (node) { tiltOn(node, 9); });
    each('.tabpanel .shot, .live-card .shot, .client-shot', function (node) { tiltOn(node, 5); });
  }

  // ── „Wygląd po Twojemu”: a 3D deck of the launcher's themes – the chosen one in front, the rest turned away ──
  var THEMES = {
    domyslny: ['Domyślny', 'Ciepły pomarańcz Hammera – za darmo dla każdego.'],
    nether: ['Nether', 'Lawa, żar i popiół w ruchomym tle.'],
    end: ['End', 'Fiolet pustki, gwiazdy i blask prętów Endu.'],
    ocean: ['Ocean', 'Pryzmaryn, bąbelki i światło z góry.'],
    wisnia: ['Wiśniowy gaj', 'Różowe barwy i spadające płatki wiśni.'],
    mrok: ['Głęboki mrok', 'Pulsujący sculk prosto z głębin.'],
  };
  var picks = Array.prototype.slice.call(document.querySelectorAll('.theme-pick'));
  var deck = $('theme-deck');
  var cards = deck ? Array.prototype.slice.call(deck.querySelectorAll('.theme-card')) : [];
  function showTheme(id) {
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
  }
  if (deck) {
    deck.classList.add('deck-ready');
    picks.forEach(function (pick) { pick.addEventListener('click', function () { showTheme(pick.getAttribute('data-theme')); }); });
    cards.forEach(function (card) { card.addEventListener('click', function () { showTheme(card.getAttribute('data-theme')); }); });
    var current = function () { return (picks.filter(function (p) { return p.getAttribute('aria-pressed') === 'true'; })[0] || picks[0]).getAttribute('data-theme'); };
    window.addEventListener('resize', function () { showTheme(current()); });
    showTheme('domyslny');
  }
})();
