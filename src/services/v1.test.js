'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cycleToDistribution, SYMBOL_BY_ADDR } = require('./v1');
const { REGISTRY } = require('../evm/stocks');

const CYCLE = {
  id: 5,
  status: 'complete',
  finished_at: '2026-07-18T00:00:00.000Z',
  eligible_holders: 2466,
  steps: [
    { name: 'claim', status: 'ok', signature: '0xclaimsig', detail: { ethClaimed: 0.5 } },
    { name: 'buy', status: 'ok', signature: '0xnvda', detail: { leg: 'reward', stock: 'NVDA', tokensBought: 1.5 } },
    { name: 'airdrop', status: 'ok', detail: { stock: 'NVDA', sent: 2466 } },
    { name: 'buy', status: 'ok', signature: '0xaapl', detail: { leg: 'reward', stock: 'AAPL', tokensBought: 2 } },
    { name: 'airdrop', status: 'ok', detail: { stock: 'AAPL', sent: 2466 } },
  ],
};

test('cycleToDistribution builds a receipt with per-stock shares valued at live prices', () => {
  const d = cycleToDistribution(CYCLE, { NVDA: 200, AAPL: 300 });
  assert.strictEqual(d.id, 'dist-5');
  assert.strictEqual(d.timestamp, Date.parse('2026-07-18T00:00:00.000Z'));
  assert.strictEqual(d.wallets, 2466);
  assert.strictEqual(d.txHash, '0xclaimsig', 'first available signature');
  assert.deepStrictEqual(d.allocations, [
    { symbol: 'NVDA', shares: 1.5, usd: 300 }, // 1.5 × 200
    { symbol: 'AAPL', shares: 2, usd: 600 }, // 2 × 300
  ]);
});

test('cycleToDistribution values a stock with no known price at usd 0, not NaN', () => {
  const d = cycleToDistribution(CYCLE, { NVDA: 200 }); // AAPL price missing
  const aapl = d.allocations.find((a) => a.symbol === 'AAPL');
  assert.strictEqual(aapl.usd, 0);
  assert.strictEqual(aapl.shares, 2);
});

test('cycleToDistribution returns null for a cycle that bought nothing', () => {
  const claimOnly = { id: 9, status: 'skipped', steps: [{ name: 'claim', status: 'ok' }] };
  assert.strictEqual(cycleToDistribution(claimOnly, {}), null);
});

test('SYMBOL_BY_ADDR maps every registry token address back to its ticker', () => {
  for (const s of REGISTRY) {
    assert.strictEqual(SYMBOL_BY_ADDR[s.token.toLowerCase()], s.symbol);
  }
});
