'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The shop's own commands – the Hammer Launcher server (BOT_PROFILE=launcher) sells nothing on Discord, so it has none of them. */
const SHOP_ONLY = new Set(['affiliate', 'balance', 'customer', 'disable', 'enable', 'product', 'promo', 'sale', 'sales', 'shop', 'vouch']);
/** Commands only the Hammer Launcher server has – /wiedza feeds the AI assistant, which only runs there. */
const LAUNCHER_ONLY = new Set(['knowledge']);

module.exports = function loadCommands() {
  const launcher = require('../lib/profile').launcher;
  const commands = new Map();
  for (const file of fs.readdirSync(__dirname)) {
    if (!file.endsWith('.js') || file === 'index.js') continue;
    if (launcher && SHOP_ONLY.has(file.slice(0, -3))) continue;
    if (!launcher && LAUNCHER_ONLY.has(file.slice(0, -3))) continue;
    const command = require(path.join(__dirname, file));
    commands.set(command.data.name, command);
  }
  return commands;
};
module.exports.SHOP_ONLY = SHOP_ONLY;
module.exports.LAUNCHER_ONLY = LAUNCHER_ONLY;
