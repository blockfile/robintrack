'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { REGISTRY, resolveStocks } = require('./stocks');

test('registry only holds stocks with a verified native-ETH V4 pool', () => {
  assert.ok(REGISTRY.length >= 10, 'has the verified stocks');
  const symbols = REGISTRY.map((s) => s.symbol);
  for (const expected of ['NVDA', 'AAPL', 'TSLA', 'SPCX', 'GOOGL', 'MSFT', 'META', 'AMZN', 'AMD', 'PLTR']) {
    assert.ok(symbols.includes(expected), `${expected} is buyable with ETH on V4`);
  }
  // Stocks with NO direct ETH pool must stay out — they'd fail every cycle.
  for (const excluded of ['COIN', 'INTC', 'ORCL', 'MU', 'BE', 'CRWV', 'SNDK', 'USAR']) {
    assert.ok(!symbols.includes(excluded), `${excluded} has no direct ETH pool and must be excluded`);
  }
});

test('every registry entry carries the V4 pool key and a pinned address', () => {
  for (const s of REGISTRY) {
    assert.match(s.token, /^0x[0-9a-f]{40}$/, `${s.symbol} address is pinned + normalised`);
    assert.strictEqual(s.fee, 50000, `${s.symbol} uses the 5% tier`);
    assert.strictEqual(s.tickSpacing, 1000);
    assert.strictEqual(s.hooks, '0x0000000000000000000000000000000000000000');
    assert.strictEqual(s.decimals, 18);
  }
});

test('resolveStocks: blank = all, symbols are case-insensitive, unknown throws', () => {
  assert.strictEqual(resolveStocks([]).length, REGISTRY.length);
  assert.strictEqual(resolveStocks(null).length, REGISTRY.length);

  const picked = resolveStocks(['nvda', ' TSLA ']);
  assert.deepStrictEqual(picked.map((s) => s.symbol), ['NVDA', 'TSLA']);

  // A typo must fail loudly rather than silently airdropping fewer stocks.
  assert.throws(() => resolveStocks(['NVDA', 'NOPE']), /unknown stock "NOPE"/);
});
