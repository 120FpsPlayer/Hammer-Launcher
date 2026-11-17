'use strict';

/**
 * Ustawienia → „Uruchamiaj razem z Windows”: the launcher's entry among the programs Windows starts at sign-in.
 *
 * Windows keeps an entry a player switched off in Task Manager → Startup (or Settings → Apps → Startup) and only
 * marks it as disabled. Writing the entry again switches it back on – so a plain start of the launcher leaves such
 * an entry alone. Only the player flipping the launcher's own switch (asked) writes it.
 */

/** The entry's name – the uninstaller removes it by this name too (build/installer.nsh). */
const NAME = 'Hammer Launcher';

/** Is our entry there, but switched off in Windows? state: what app.getLoginItemSettings() returned. */
function switchedOffInWindows(state, name = NAME) {
  return (state?.launchItems ?? []).some((item) => item?.name === name && item.enabled === false);
}

/**
 * What to write now: the options for app.setLoginItemSettings, or null to leave the entry as it is.
 * want – the launcher's setting; asked – the player has just changed that setting; state – app.getLoginItemSettings().
 */
function loginItemChange({ want, asked = false, state = null, execPath }) {
  if (want && !asked && switchedOffInWindows(state)) return null;
  return { openAtLogin: Boolean(want), path: execPath, args: ['--background'], name: NAME };
}

module.exports = { NAME, switchedOffInWindows, loginItemChange };
