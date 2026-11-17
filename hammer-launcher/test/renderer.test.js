'use strict';

/* The interface itself: the real pages of src/renderer in Chromium, with the preview's fake launcher behind
   window.hs (scripts/preview.js → mock) – no Electron, no network. Each test walks one path the way a player
   does and looks at what is on the screen; where the order of answers matters, the test holds an answer back
   and lets it go itself (no waiting on a clock).
   Needs Playwright's Chromium (npx playwright install chromium) – without it the tests are skipped. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let chromium = null;
let mock = null;
let PAGE = null;
let available = false;
try {
  ({ chromium } = require('playwright'));
  ({ mock, PAGE } = require('../scripts/preview'));
  available = fs.existsSync(chromium.executablePath());
} catch {
  // Playwright is a development tool – a machine without it still runs every other test
}
const skip = available ? false : 'Chromium (Playwright) is not installed here – npx playwright install chromium';
const COSMETICS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'assets', 'cosmetics', 'cosmetics.json'), 'utf8'));

let browser = null;
const walks = []; // [name, walk] – run at the bottom of the file, a few windows at a time
const ui = (name, walk) => walks.push([name, walk]);

/**
 * Opens the launcher's window on the fake launcher and runs `walk({ page, nav, until })` in it. `patch(arg)` (one
 * function or a list of them) runs inside the page right after the fake launcher is set up – it may replace its
 * answers. An error in the page's console fails the test.
 */
async function withLauncher({ patch = null, arg = null, width = 1240, height = 780 } = {}, walk) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(10000); // (a step that never comes fails the test soon, not after Playwright's half minute)
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  try {
    await page.addInitScript((list) => (window.__cosmetics = list), COSMETICS);
    await page.addInitScript(mock);
    for (const fn of [patch].flat().filter(Boolean)) await page.addInitScript(fn, arg);
    await page.goto(PAGE);
    await page.waitForSelector('#app:not(.booting)');
    const nav = (title) => page.locator('.nav-item', { hasText: title }).click();
    /** Waits until fn() – run in the page – answers something true, and returns it. */
    const until = (fn, value) => page.waitForFunction(fn, value, { timeout: 10000 }).then((handle) => handle.jsonValue());
    await walk({ page, nav, until });
    assert.deepEqual(errors, [], 'no errors in the page');
  } finally {
    await page.close();
  }
}

/** A click with one progress event of a downloading game between the press and the release of the mouse button. */
async function clickDuringDownload(page, locator) {
  await locator.first().scrollIntoViewIfNeeded();
  const box = await locator.first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => window.__emit('game:progress', { instanceId: 'survival', stage: 'minecraft', label: 'Pobieranie Minecrafta', done: 412, total: 1000, percent: 41 }));
  await page.mouse.up();
}

/* The loader lists of the fake launcher, with Forge held back until the test lets it answer – the way its big
   Maven list arrives after Fabric's in real life. Forge has nothing for the newest game version. */
function slowForge() {
  const forge = Array.from({ length: 120 }, (_, n) => ({ version: `47.4.${119 - n}`, stable: true }));
  const lists = { fabric: () => [{ version: '0.16.10', stable: true }, { version: '0.16.9', stable: true }], quilt: () => [{ version: '0.27.1', stable: true }], neoforge: () => [{ version: '21.1.77', stable: true }], forge: (mc) => (mc === '1.20.1' ? forge : []) };
  window.__held = [];
  window.__letGo = () => window.__held.splice(0).forEach((answer) => answer());
  window.hs.versions.loaders = (loader, mc) =>
    new Promise((resolve) => {
      const answer = () => resolve(lists[loader]?.(mc) ?? []);
      if (loader === 'forge' && !window.__forgeAtOnce) window.__held.push(answer);
      else answer();
    });
}

ui('a download in progress does not eat clicks: progress moves only the progress bar, the lists stay as they are', async () => {
  await withLauncher({}, async ({ page, nav, until }) => {
    // Another instance is being downloaded: the launcher sends its progress ten times a second.
    await page.evaluate(() => {
      HS.state.running.set('survival', 'preparing');
      HS.state.progress.set('survival', { label: 'Przygotowanie…', percent: null });
      HS.bus.emit('game');
    });

    await clickDuringDownload(page, page.locator('.instance-pick'));
    await page.locator('.menu').waitFor();
    await page.locator('.tb-drag').click(); // (a click anywhere else closes the menu)

    await nav('Instancje');
    await clickDuringDownload(page, page.locator('.inst-card .more'));
    await page.locator('.menu').waitFor();
    await page.locator('.tb-drag').click();

    await nav('Serwery');
    await until(() => document.querySelectorAll('.server-row').length > 0 && document.querySelectorAll('.server-row .spinner').length <= 1); // (the rows have their ping answers; one server of the fake list never answers)
    await clickDuringDownload(page, page.locator('.server-row button[title="Edytuj"]'));
    await page.locator('.modal').waitFor();
    await page.keyboard.press('Escape');

    await nav('Światy');
    await clickDuringDownload(page, page.locator('.world-row button[title="Zmień nazwę"]'));
    await page.locator('.modal').waitFor();
    await page.keyboard.press('Escape');

    await nav('Ustawienia');
    const box = page.locator('.clean-row input[type=checkbox]').first();
    await until(() => document.querySelector('.disk-bar') && document.querySelector('.clean-row')); // (the disk card has both its parts)
    const before = await box.isChecked();
    await clickDuringDownload(page, box);
    assert.equal(await page.locator('.clean-row input[type=checkbox]').first().isChecked(), !before, 'Ustawienia → Sprzątanie: the box was ticked');

    // The progress itself still shows: on the start screen for the selected instance…
    await page.evaluate(() => HS.state.selectInstance('survival'));
    await nav('Graj');
    await page.evaluate(() => window.__emit('game:progress', { instanceId: 'survival', stage: 'java', label: 'Pobieranie Javy', done: 70, total: 100, percent: 70 }));
    assert.equal(await until(() => document.querySelector('.play-progress .label')?.textContent), 'Pobieranie Javy70%');
    assert.equal((await page.locator('.play-btn').innerText()).trim(), 'PRZYGOTOWANIE');
    // …and in the „Test FPS” card while the game of a test is being prepared.
    await page.evaluate(() => {
      HS.state.running.clear();
      HS.state.selectInstance('hammershop');
    });
    await nav('Optymalizacja');
    await page.locator('.bench .bench-form').waitFor();
    await page.evaluate(() => {
      HS.state.running.set('hammershop', 'preparing');
      HS.state.progress.set('hammershop', { label: 'Przygotowanie…', percent: null });
      HS.state.benchmarks.add('hammershop');
      HS.bus.emit('game');
    });
    assert.equal(await until(() => document.querySelector('.bench-run small')?.textContent), 'Przygotowanie…');
    await page.evaluate(() => window.__emit('game:progress', { instanceId: 'hammershop', stage: 'minecraft', label: 'Pobieranie Minecrafta', done: 1, total: 100, percent: 1 }));
    assert.equal(await until(() => document.querySelector('.bench-run small')?.textContent !== 'Przygotowanie…' && document.querySelector('.bench-run small')?.textContent), 'Pobieranie Minecrafta');
  });
});

ui('instance editor: a late answer for a loader the player has already left never replaces the list', async () => {
  await withLauncher({ patch: slowForge }, async ({ page, nav, until }) => {
    const loaderList = () => page.evaluate(() => [...document.querySelectorAll('.modal select')[1].options].slice(0, 3).map((o) => o.textContent));
    const pick = (name) => page.locator('.modal .seg button', { hasText: new RegExp(`^${name}$`) }).click();
    const settled = () => until(() => !document.querySelectorAll('.modal select')[1].disabled);
    await nav('Instancje');
    await page.locator('.page-head .btn.primary').click();
    await settled();

    // Forge (slow, and it has nothing for the newest game version), then straight back to Fabric.
    await pick('Forge');
    await pick('Fabric');
    await settled();
    await page.evaluate(() => window.__letGo());
    await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    assert.deepEqual(await loaderList(), ['Najnowsza zalecana', '0.16.10', '0.16.9']);
    assert.equal(await page.locator('.modal .warn').count(), 0, 'no „Fabric nie ma jeszcze wersji…” from Forge\'s empty list');

    // The same on a game version Forge does have: its builds must not end up under Fabric.
    await page.locator('.modal select').first().selectOption('1.20.1');
    await settled();
    await pick('Forge');
    await pick('Fabric');
    await settled();
    await page.evaluate(() => window.__letGo());
    await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    assert.deepEqual(await loaderList(), ['Najnowsza zalecana', '0.16.10', '0.16.9']);

    // Forge picked and waited for: its list does arrive.
    await pick('Forge');
    await page.evaluate(() => window.__letGo());
    await settled();
    assert.deepEqual(await loaderList(), ['Najnowsza zalecana', '47.4.119', '47.4.118']);
  });
});

ui('instance editor: „pokaż snapshoty” ticked while the first list is still loading keeps the snapshots', async () => {
  const patch = () => {
    const releases = ['1.21.1', '1.20.1'].map((id) => ({ id, type: 'release' }));
    let first = true;
    window.hs.versions.minecraft = ({ snapshots } = {}) =>
      new Promise((resolve) => {
        const answer = () => resolve(snapshots ? [{ id: '26w01a', type: 'snapshot' }, ...releases] : releases);
        if (first) window.__letGo = answer; // the very first question (without snapshots) is answered last
        else answer();
        first = false;
      });
  };
  await withLauncher({ patch }, async ({ page, nav, until }) => {
    await nav('Instancje');
    await page.locator('.page-head .btn.primary').click();
    await page.locator('.modal label', { hasText: 'pokaż snapshoty' }).locator('input').check();
    await until(() => !document.querySelector('.modal select').disabled);
    await page.evaluate(() => window.__letGo());
    await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    assert.deepEqual(await page.evaluate(() => [...document.querySelector('.modal select').options].map((o) => o.textContent)), ['26w01a (snapshot)', '1.21.1', '1.20.1']);
  });
});

ui('instance editor: a loader version that is not among the newest 80 stays selected – not „Najnowsza zalecana”', async () => {
  const patch = () => {
    window.__forgeAtOnce = true;
    // A modpack asked for an older Forge build (the list has 120 – only the newest 80 are offered).
    const list = window.hs.instances.list;
    window.hs.instances.list = async () => (await list()).map((i) => (i.id === 'survival' ? { ...i, loaderVersion: '47.4.5' } : i));
  };
  await withLauncher({ patch: [slowForge, patch] }, async ({ page, nav, until }) => {
    await nav('Instancje');
    await page.locator('.inst-card h3', { hasText: 'Survival z ekipą' }).dblclick();
    await until(() => document.querySelectorAll('.modal select')[1] && !document.querySelectorAll('.modal select')[1].disabled);
    const shown = await page.evaluate(() => {
      const sel = document.querySelectorAll('.modal select')[1];
      return { selected: sel.selectedOptions[0].textContent, value: sel.value, first: sel.options[0].textContent, count: sel.options.length };
    });
    assert.deepEqual(shown, { selected: '47.4.5', value: '47.4.5', first: 'Najnowsza zalecana', count: 82 });
  });
});

ui('invitation: the window closed while the modpack downloads – the new instance still shows up, with a message', async () => {
  const patch = () => {
    window.hs.invite.accept = () =>
      new Promise((resolve) => {
        window.__letGo = () => {
          const made = { id: 'z-zaproszenia', name: 'Serwer Oli', mcVersion: '1.19.4', loader: 'fabric', icon: 'star', playTimeMs: 0, lastPlayed: null };
          const list = window.hs.instances.list;
          window.hs.instances.list = async () => [...(await list()), made];
          resolve({ instance: made, created: true, added: true, name: 'Serwer Oli', server: 'ola.example.pl' });
        };
      });
  };
  await withLauncher({ patch }, async ({ page, nav, until }) => {
    await nav('Instancje');
    const cards = page.locator('.inst-card:not(.new-card)');
    const before = await cards.count();
    await page.evaluate(() => HS.inviteUi.fromLink('hammer://join?server=ola.example.pl&name=Serwer%20Oli&mc=1.19.4&loader=fabric'));
    await page.locator('.modal label.pick-row', { hasText: 'Utwórz nową instancję' }).click();
    await page.locator('.modal .modal-foot .btn.primary').click();
    await page.keyboard.press('Escape'); // the download takes minutes – the player goes on with something else
    await page.locator('.modal').waitFor({ state: 'detached' });
    await page.evaluate(() => window.__letGo());
    await page.locator('.inst-card h3', { hasText: 'Serwer Oli' }).waitFor();
    assert.equal(await cards.count(), before + 1);
    assert.match(await page.locator('.toast.ok').innerText(), /^Instancja „Serwer Oli” jest gotowa – serwer „Serwer Oli” jest na jej liście\.\s*Graj$/);
  });
});

ui('Mody: after „Zmień loader” the page is drawn for the new loader, not left on „czysty Minecraft”', async () => {
  await withLauncher({}, async ({ page, nav, until }) => {
    await page.evaluate(() => HS.state.selectInstance('pvp')); // a vanilla instance
    await nav('Mody');
    await page.locator('.empty h3', { hasText: 'Ta instancja to czysty Minecraft' }).waitFor();
    await page.locator('button', { hasText: 'Zmień loader' }).click();
    await until(() => !document.querySelector('.modal select').disabled);
    await page.locator('.modal .seg button', { hasText: /^Fabric$/ }).click();
    await page.locator('.modal .modal-foot .btn.primary').click();
    await page.locator('.modal').waitFor({ state: 'detached' });
    await page.locator('.project').first().waitFor(); // the mods to browse
    assert.equal(await page.locator('.empty h3', { hasText: 'Ta instancja to czysty Minecraft' }).count(), 0);
    assert.equal(await page.locator('.instance-pick small').innerText(), 'Minecraft 1.8.9 · Fabric');
  });
});

ui('a crash of an instance that is not the selected one: Konsola opens on that instance, with the explanation', async () => {
  await withLauncher({}, async ({ page, nav, until }) => {
    await page.evaluate(() => {
      HS.state.running.set('survival', 'running');
      HS.bus.emit('game');
    });
    await nav('Mody'); // „Hammer” is selected, „Survival z ekipą” is in the game
    await page.evaluate(() => window.__emit('game:state', { instanceId: 'survival', state: 'crashed', crash: { title: 'Zabrakło pamięci RAM', hints: ['Zwiększ pamięć RAM w zakładce Optymalizacja.'], details: 'java.lang.OutOfMemoryError: Java heap space' } }));
    await page.locator('.crash h3', { hasText: 'Zabrakło pamięci RAM' }).waitFor();
    assert.equal(await page.locator('.page-head h1').innerText(), 'Konsola');
    assert.equal(await page.locator('.instance-pick b').innerText(), 'Survival z ekipą');
  });
});

ui('Escape closes only the window on top', async () => {
  await withLauncher({}, async ({ page, nav, until }) => {
    await nav('Mody');
    await page.locator('.seg button', { hasText: 'Paczki modów' }).click();
    await page.locator('.project h3').first().click();
    await page.locator('.modal .installed-row .btn.sm').first().click(); // „Zainstalować …?” over the modpack's window
    await until(() => document.querySelectorAll('#modal-root .overlay').length === 2);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#modal-root .overlay').count(), 1, 'the question is gone, the window under it stays');
    assert.equal(await page.locator('.modal h2', { hasText: 'Zainstalować' }).count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#modal-root .overlay').count(), 0);
  });
});

ui('Optymalizacja: the summary names the instance that was optimised, also when another one was picked meanwhile', async () => {
  const patch = () => {
    const apply = window.hs.optimizer.apply;
    window.hs.optimizer.apply = (...args) => new Promise((resolve) => (window.__letGo = () => resolve(apply(...args))));
  };
  await withLauncher({ patch }, async ({ page, nav, until }) => {
    await nav('Optymalizacja');
    await page.locator('button', { hasText: 'Zoptymalizuj wszystko' }).click();
    await until(() => typeof window.__letGo === 'function');
    await page.evaluate(() => HS.state.selectInstance('survival'));
    await page.evaluate(() => window.__letGo());
    await page.locator('.modal').waitFor();
    assert.equal(await page.locator('.modal .muted').first().innerText(), 'Oto, co launcher zrobił dla „Hammer”:');
  });
});

ui('Optymalizacja without any instance: after „Nowa instancja” the page is there for it', async () => {
  const patch = () => {
    window.hs.instances.list = async () => window.__made ?? [];
    window.hs.instances.create = async (data) => (window.__made = [{ id: 'nowa', playTimeMs: 0, lastPlayed: null, ...data }])[0];
  };
  await withLauncher({ patch }, async ({ page, nav, until }) => {
    await nav('Optymalizacja');
    await page.locator('.empty button', { hasText: 'Nowa instancja' }).click();
    await until(() => !document.querySelector('.modal select').disabled);
    await page.locator('.modal .modal-foot .btn.primary').click();
    await page.locator('.modal').waitFor({ state: 'detached' });
    await page.locator('button', { hasText: 'Zoptymalizuj wszystko' }).waitFor();
    assert.equal(await page.locator('.empty h3', { hasText: 'Brak instancji' }).count(), 0);
  });
});

ui('GRAJ clicked twice in a row starts the game once', async () => {
  const patch = () => {
    // A slow disk: saving the selected instance takes a moment – long enough for the second click.
    const set = window.hs.settings.set;
    window.hs.settings.set = (p) => new Promise((resolve) => (window.__held ??= []).push(() => resolve(set(p))));
    window.__launches = 0;
    let preparing = false;
    window.hs.game.launch = async () => {
      window.__launches += 1;
      if (preparing) throw new Error('Gra jest już przygotowywana.'); // what the launcher answers to a second start
      preparing = true;
      return new Promise(() => {});
    };
  };
  await withLauncher({ patch }, async ({ page, nav, until }) => {
    await page.locator('.play-btn').dblclick();
    await page.evaluate(() => window.__held.splice(0).forEach((save) => save()));
    await until(() => window.__launches > 0);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    assert.equal(await page.evaluate(() => window.__launches), 1);
    assert.equal(await page.evaluate(() => HS.state.running.get('hammershop')), 'preparing');
    assert.equal((await page.locator('.play-btn').innerText()).trim(), 'PRZYGOTOWANIE');
    assert.equal(await page.locator('.toast.err').count(), 0);
  });
});

ui('a long instance name at the smallest window: the switcher is cut with „…”, nothing runs off the page', async () => {
  const patch = () => {
    const list = window.hs.instances.list;
    window.hs.instances.list = async () => (await list()).map((i) => (i.id === 'hammershop' ? { ...i, name: 'M'.repeat(48) } : i)); // 48 = the longest name an instance can have
  };
  await withLauncher({ patch, width: 1040, height: 660 }, async ({ page, nav, until }) => {
    for (const title of ['Graj', 'Mody', 'Serwery', 'Światy', 'Optymalizacja', 'Galeria', 'Konsola']) {
      await nav(title);
      await page.locator(title === 'Galeria' ? '.page-head select' : '.instance-pick').first().waitFor();
      const box = await page.evaluate(() => {
        const view = document.getElementById('view').getBoundingClientRect();
        const pick = document.querySelector('#view .instance-pick, #view .page-head select').getBoundingClientRect();
        const head = document.querySelector('#view .page-head h1')?.getBoundingClientRect();
        return { scroll: document.getElementById('view').scrollWidth - document.getElementById('view').clientWidth, over: Math.round(pick.right - view.right), headWidth: head ? Math.round(head.width) : null };
      });
      assert.equal(box.scroll, 0, `${title}: the page does not scroll sideways`);
      assert.ok(box.over <= 0, `${title}: the instance switcher ends inside the page (${box.over}px over)`);
      if (box.headWidth != null) assert.ok(box.headWidth >= 120, `${title}: the heading keeps its room (${box.headWidth}px)`);
    }
  });
});

ui('a name without spaces wraps in a window and in a message – the close button stays, nothing scrolls sideways', async () => {
  const patch = () => {
    const instances = window.hs.instances.list;
    const worlds = window.hs.worlds.list;
    window.hs.instances.list = async () => (await instances()).map((i) => (i.id === 'hammershop' ? { ...i, name: 'M'.repeat(48) } : i));
    window.hs.worlds.list = async (id) => (await worlds(id)).map((w, n) => (n === 0 ? { ...w, name: 'W'.repeat(64), folder: 'W'.repeat(64) } : w));
  };
  await withLauncher({ patch, width: 1040, height: 660 }, async ({ page, nav, until }) => {
    /** How far the newest window's content reaches past its right edge, and how far its text scrolls sideways. */
    const spill = () =>
      page.evaluate(() => {
        const box = [...document.querySelectorAll('#modal-root .modal')].at(-1);
        const body = box.querySelector('.modal-body');
        const right = Math.max(...[...box.querySelectorAll('.modal-head *')].map((el) => el.getBoundingClientRect().right));
        return { head: Math.max(0, Math.round(right - box.getBoundingClientRect().right)), body: body.scrollWidth - body.clientWidth };
      });
    await page.evaluate(() => HS.editInstance(HS.state.instance)); // „Edytuj: MMMM…”
    await page.locator('.modal').waitFor();
    assert.deepEqual(await spill(), { head: 0, body: 0 }, 'the title of „Edytuj”');
    await page.keyboard.press('Escape');

    await nav('Światy');
    await page.locator('.world-row .row-acts .danger').first().click(); // „Usunąć świat?” with the name in its text
    await page.locator('.modal').waitFor();
    assert.deepEqual(await spill(), { head: 0, body: 0 }, 'the text of „Usunąć świat?”');
    await page.locator('.modal .btn.danger').click();
    await page.locator('.toast.ok').waitFor(); // „Świat „WWWW…” jest w koszu.”
    const toast = await page.evaluate(() => {
      const el = document.querySelector('.toast.ok');
      return Math.round(Math.max(...[...el.querySelectorAll('*')].map((x) => x.getBoundingClientRect().right)) - el.getBoundingClientRect().right);
    });
    assert.ok(toast <= 0, `the message keeps its text inside (${toast}px over)`);
  });
});

/* One Chromium for the whole file; every test has a window (and a fake launcher) of its own. */
test.describe('the interface in Chromium', { concurrency: 4 }, () => {
  test.before(async () => {
    if (available) browser = await chromium.launch();
  });
  test.after(async () => {
    await browser?.close();
  });
  for (const [name, walk] of walks) test(name, { skip }, walk);
});
