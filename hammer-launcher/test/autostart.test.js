'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NAME, switchedOffInWindows, loginItemChange } = require('../src/main/autostart');

const exe = 'C:\\Users\\Kuba\\AppData\\Local\\Programs\\Hammer Launcher\\Hammer Launcher.exe';
/** What Electron reports on Windows: our entry in the Run key and whether Task Manager has it enabled. */
const windows = (enabled, name = NAME) => ({ openAtLogin: false, executableWillLaunchAtLogin: enabled, launchItems: [{ name, path: exe, args: ['--background'], scope: 'user', enabled }] });

test('a start-up entry the player switched off in Task Manager stays off when the launcher starts', () => {
  assert.equal(switchedOffInWindows(windows(false)), true);
  assert.equal(loginItemChange({ want: true, state: windows(false), execPath: exe }), null, 'nothing is written – writing would switch it back on');
});

test('the launcher\'s own switch still writes the entry – on and off', () => {
  const on = loginItemChange({ want: true, asked: true, state: windows(false), execPath: exe });
  assert.deepEqual(on, { openAtLogin: true, path: exe, args: ['--background'], name: 'Hammer Launcher' });
  const off = loginItemChange({ want: false, asked: true, execPath: exe });
  assert.equal(off.openAtLogin, false);
});

test('an ordinary start keeps the entry in step with the setting', () => {
  // First start after installing: no entry yet → written.
  assert.equal(loginItemChange({ want: true, state: { launchItems: [] }, execPath: exe }).openAtLogin, true);
  // Enabled entry → written again (the path may have changed with an update).
  assert.equal(loginItemChange({ want: true, state: windows(true), execPath: exe }).openAtLogin, true);
  // The setting is off → the entry goes, whatever Windows says about it.
  assert.equal(loginItemChange({ want: false, state: windows(false), execPath: exe }).openAtLogin, false);
  // Another program's entry for the same file, or a system that reports nothing, changes nothing.
  assert.equal(switchedOffInWindows(windows(false, 'Something Else')), false);
  assert.equal(loginItemChange({ want: true, state: undefined, execPath: exe }).openAtLogin, true);
  assert.equal(loginItemChange({ want: true, state: { launchItems: [null, {}] }, execPath: exe }).openAtLogin, true);
});
