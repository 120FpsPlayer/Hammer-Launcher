'use strict';

// The Hammer Launcher server and site sell in złoty: Hammer+ prices, Stripe payments, e-mails and Discord texts.
process.env.HS_TEST_PROFILE = 'launcher';

require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/lib/config');
const { currencyCode } = require('../src/lib/currency');
const { money } = require('../src/lib/utils');

test('the launcher profile sells in PLN: Stripe, the website\'s prices and the Discord texts', () => {
  assert.equal(currencyCode(config.stripe.currency), 'pln', 'Stripe charges in złoty');
  assert.equal(currencyCode(), 'pln', 'the website (Hammer+ plans, orders, e-mails) works in złoty');
  assert.equal(money(14.99), '14,99 zł');
  assert.equal(money(20), '20 zł');
});
