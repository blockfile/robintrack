'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

// One mongo server for the whole file: config.mongoUri is captured when db/index
// first loads config, so a second connect() in the same process would point at
// the first (stopped) server. Both scenarios share one connection.
let mongod;
let db;
let repo;
let simvault;
let runCycle;

before(async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsliqui_test_cycle';
  delete require.cache[require.resolve('../config')];
  db = require('../db/index');
  repo = require('../db/repository');
  simvault = require('../evm/simvault');
  ({ runCycle } = require('./cycle'));
  await db.connect();
});

after(async () => {
  await db.close();
  await mongod.stop();
  delete require.cache[require.resolve('../config')];
  delete process.env.TOKEN_ADDRESS;
});

test('runCycle (DRY_RUN): claim → buy each stock on V4 + airdrop → buy PONZI + burn → dev', async () => {
  const { REGISTRY } = require('../evm/stocks');
  simvault.reset(0.05); // creator-fee vault has fees to claim
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'complete');
  assert.strictEqual(cycle.mode, 'stocks-reward-burn');

  // Reward leg = one buy + one airdrop PER STOCK, then the burn leg (buy + burn).
  const names = cycle.steps.map((s) => s.name);
  assert.strictEqual(names[0], 'claim');
  assert.deepStrictEqual(names.slice(-2), ['buy', 'burn'], 'burn leg last');
  const buys = cycle.steps.filter((s) => s.name === 'buy' && s.detail?.leg === 'reward');
  const drops = cycle.steps.filter((s) => s.name === 'airdrop');
  assert.strictEqual(buys.length, REGISTRY.length, 'one buy per stock');
  assert.strictEqual(drops.length, REGISTRY.length, 'one airdrop per stock');

  // Each stock is bought and dropped under its own symbol.
  assert.deepStrictEqual(
    drops.map((d) => d.detail.stock).sort(),
    REGISTRY.map((s) => s.symbol).sort()
  );

  assert.ok(cycle.eth_claimed > 0);
  // 80% of the claim funds the stock buys, split evenly across the registry.
  assert.ok(Math.abs(cycle.eth_spent_buy - cycle.eth_claimed * 0.8) < 1e-6, '80% spent on stocks');
  const perStock = (cycle.eth_claimed * 0.8) / REGISTRY.length;
  assert.ok(Math.abs(buys[0].detail.ethSpent - perStock) < 1e-6, 'reward ETH split evenly per stock');
  assert.ok(cycle.tokens_burned > 0, 'burned PONZI');

  // Two simulated eligible holders (operating wallet excluded) — the SAME
  // snapshot is used for every stock.
  assert.strictEqual(cycle.eligible_holders, 2);
  assert.strictEqual(cycle.total_holders, 3);
  for (const d of drops) {
    assert.strictEqual(d.detail.sent, 2);
    assert.strictEqual(d.detail.failed, 0);
  }

  // Airdrop rows persisted per stock token: every stock paid both holders.
  const totals = await repo.getAirdropTotals();
  assert.strictEqual(Object.keys(totals).length, REGISTRY.length, 'one total per stock token');
  for (const t of Object.values(totals)) {
    assert.strictEqual(t.holders, 2);
    assert.strictEqual(t.sends, 2);
  }
});

test('runCycle (DRY_RUN): nothing claimable → skipped', async () => {
  simvault.reset(0); // empty vault
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'skipped');
  assert.ok(cycle.steps.some((s) => s.name === 'claim'));
  assert.ok(!cycle.steps.some((s) => s.name === 'buy'));
});
