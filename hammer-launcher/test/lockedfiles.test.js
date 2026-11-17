'use strict';

// On Windows a running game keeps its mods' .jar files open: switching a mod off or removing it is refused by the
// system. The player gets a Polish sentence with what to do – not a raw "EBUSY: resource busy or locked, rename …".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createModrinth } = require('../src/main/modrinth');
const { createContent } = require('../src/main/content');
const { createInstances } = require('../src/main/instances');
const { createPaths } = require('../src/main/paths');
const { tmpDir, fabricJar } = require('./helpers');

function setup() {
  const fetchFn = async () => new Response('nope', { status: 404 });
  const instance = createInstances(createPaths(tmpDir())).create({ name: 'Test', mcVersion: '1.21.1', loader: 'fabric' });
  const content = createContent({ modrinth: createModrinth({ fetchFn, sleep: async () => {} }), fetchFn });
  const file = path.join(instance.dir, 'mods', 'sodium-0.6.0.jar');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fabricJar({ id: 'sodium', name: 'Sodium', version: '0.6.0' }));
  return { content, instance, file };
}

/** Windows refusing a file the game holds: the call throws like the real one does. */
function locked(method, code, fn) {
  const real = fs[method];
  fs[method] = (target) => {
    throw Object.assign(new Error(`${code}: resource busy or locked, ${method} '${target}'`), { code });
  };
  try {
    return fn();
  } finally {
    fs[method] = real;
  }
}

test('switching off a mod the running game holds open: a Polish sentence with what to do, the file stays as it was', () => {
  const { content, instance, file } = setup();
  locked('renameSync', 'EBUSY', () => {
    assert.throws(() => content.setEnabled(instance, 'mod', 'sodium-0.6.0.jar', false), (err) => {
      assert.equal(err.message, 'Nie udało się wyłączyć pliku „sodium-0.6.0.jar”: plik jest używany przez inny program. Jeśli gra jest włączona, zamknij ją i spróbuj ponownie.');
      assert.equal(err.cause.code, 'EBUSY');
      return true;
    });
  });
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(content.list(instance, 'mod').map((m) => [m.file, m.enabled]), [['sodium-0.6.0.jar', true]]);
  // Once the game is closed the same click works.
  content.setEnabled(instance, 'mod', 'sodium-0.6.0.jar', false);
  assert.equal(fs.existsSync(`${file}.disabled`), true);
  locked('renameSync', 'EPERM', () => {
    assert.throws(() => content.setEnabled(instance, 'mod', 'sodium-0.6.0.jar', true), /^Error: Nie udało się włączyć pliku „sodium-0\.6\.0\.jar”: brak uprawnień .*zamknij ją i spróbuj ponownie\.$/);
  });
});

test('removing a mod the running game holds open: the same sentence, and the mod stays on the list', () => {
  const { content, instance, file } = setup();
  locked('rmSync', 'EPERM', () => {
    assert.throws(() => content.remove(instance, 'mod', 'sodium-0.6.0.jar'), /^Error: Nie udało się usunąć pliku „sodium-0\.6\.0\.jar”: brak uprawnień \(plik może być otwarty w innym programie albo blokuje go antywirus\)\. Jeśli gra jest włączona, zamknij ją i spróbuj ponownie\.$/);
  });
  assert.equal(fs.existsSync(file), true);
  assert.equal(content.list(instance, 'mod').length, 1);
  content.remove(instance, 'mod', 'sodium-0.6.0.jar');
  assert.equal(content.list(instance, 'mod').length, 0);
});
