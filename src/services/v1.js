'use strict';

// The /v1 API — the exact shapes the Robinhood Index Fund frontend renders, so
// its client is a thin passthrough. Everything here is real: stock prices from
// the live V4 pools, $RIF price + market cap from DexScreener, distributions
// rebuilt from the on-chain cycle history and valued at the live prices.

const config = require('../config');
const repo = require('../db/repository');
const { getEthPriceUsd } = require('../evm/price');
const { getMarketData } = require('./marketdata');
const { getStockPricesUsd } = require('../evm/stockprice');
const { nextRun } = require('./countdown');
const { sumAirdrops } = require('./format');
const { REGISTRY } = require('../evm/stocks');

// reward_token address (lowercased) -> ticker, for pricing airdrop totals.
const SYMBOL_BY_ADDR = Object.fromEntries(REGISTRY.map((s) => [s.token.toLowerCase(), s.symbol]));

/** GET /v1/stocks — the constituents with a LIVE per-share USD price. */
async function buildStocks() {
  const prices = await getStockPricesUsd().catch(() => ({}));
  return REGISTRY.map((s) => ({
    symbol: s.symbol,
    name: s.name,
    address: s.token,
    priceUsd: prices[s.symbol] ?? null,
  }));
}

/** GET /v1/stats — protocol overview. */
async function buildStats() {
  const [stats, market, airdropTotals, stockPrices] = await Promise.all([
    repo.getStats(),
    getMarketData().catch(() => ({ marketCap: null, priceUsd: null })),
    repo.getAirdropTotals().catch(() => ({})),
    getStockPricesUsd().catch(() => ({})),
  ]);

  // Total USD ever distributed = Σ (units airdropped per stock × its live price).
  let totalUsd = 0;
  for (const [addr, t] of Object.entries(airdropTotals)) {
    const sym = SYMBOL_BY_ADDR[String(addr).toLowerCase()];
    const px = sym ? stockPrices[sym] : null;
    if (px) totalUsd += (t.totalUi || 0) * px;
  }

  const { nextAirdropAt, intervalSec } = nextRun(config.pollSchedule, Date.now());
  const holders = sumAirdrops(airdropTotals).rewardHolders;

  return {
    ticker: config.tokenSymbol,
    contractAddress: config.tokenAddress,
    marketCapUsd: market.marketCap ?? null, // null until the token is listed on DexScreener
    indexPriceUsd: market.priceUsd ?? null, // null until listed
    totalValueDistributedUsd: +totalUsd.toFixed(2),
    feesCollectedEth: +(stats.total_eth_claimed || 0).toFixed(6),
    rifBurned: stats.total_tokens_burned || 0, // token-side fee RIF burned to date
    burns: stats.burns || 0,
    wallets: holders,
    holders,
    distributionIntervalSeconds: intervalSec,
    nextDistributionAt: nextAirdropAt,
    feePercent: 1,
    eligibilityThreshold: config.minHold,
  };
}

/** One cycle's steps → a distribution receipt, or null if it bought nothing. */
function cycleToDistribution(cycle, stockPrices) {
  const steps = cycle.steps || [];
  const buys = steps.filter((s) => s.name === 'buy' && s.detail && s.detail.leg === 'reward' && s.status === 'ok');
  if (!buys.length) return null;

  const allocations = buys.map((s) => {
    const symbol = s.detail.stock;
    const shares = Number(s.detail.tokensBought) || 0;
    const px = stockPrices[symbol] ?? 0;
    return { symbol, shares, usd: +(shares * px).toFixed(2) };
  });
  const airdrop = steps.find((s) => s.name === 'airdrop');

  return {
    id: `dist-${cycle.id}`,
    timestamp: Date.parse(cycle.finished_at || cycle.started_at) || Date.now(),
    wallets: cycle.eligible_holders ?? (airdrop && airdrop.detail ? airdrop.detail.sent : 0) ?? 0,
    txHash: steps.map((s) => s.signature).find(Boolean) ?? null,
    allocations,
  };
}

/** GET /v1/distributions — recent distribution receipts, newest first. */
async function buildDistributions(limit = 12) {
  const [{ items }, stockPrices] = await Promise.all([
    repo.getCycles(limit, 0),
    getStockPricesUsd().catch(() => ({})),
  ]);
  const complete = items.filter((c) => c.status === 'complete');
  const full = await Promise.all(complete.map((c) => repo.getCycleWithSteps(c.id)));
  return full
    .filter(Boolean)
    .map((c) => cycleToDistribution(c, stockPrices))
    .filter(Boolean);
}

module.exports = { buildStocks, buildStats, buildDistributions, cycleToDistribution, SYMBOL_BY_ADDR };
