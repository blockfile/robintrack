'use strict';

require('dotenv').config();

const { Wallet } = require('ethers');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function parseClusters(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((g) => Array.isArray(g))
      .map((g) => g.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()))
      .filter((g) => g.length > 0);
  } catch (_err) {
    console.warn('[ponsliqui] CLUSTERS is not valid JSON — ignoring');
    return [];
  }
}

const DRY_RUN = bool(process.env.DRY_RUN, true);

/**
 * Load the signing wallet (0x-prefixed hex private key). It must be the wallet
 * that deployed PONZI on pons.family — the creator fee share is paid to the
 * deployer address, and that wallet is authorized to call collectFees(). In
 * DRY_RUN with no key configured, an ephemeral wallet is generated so the server
 * runs out of the box (no funds are ever touched).
 */
function loadWallet() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    if (!DRY_RUN) {
      throw new Error('WALLET_PRIVATE_KEY is required when DRY_RUN=false');
    }
    return { wallet: Wallet.createRandom(), ephemeral: true };
  }
  try {
    const key = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
    return { wallet: new Wallet(key), ephemeral: false };
  } catch (err) {
    throw new Error(`Could not parse WALLET_PRIVATE_KEY: ${err.message}`);
  }
}

const { wallet, ephemeral: walletIsEphemeral } = loadWallet();

const lowerOrNull = (v) => (v ? String(v).trim().toLowerCase() : null);

// ── Buyback / reward split (of each WETH claim) ──────────────────────────────
// REWARD_BUY_PCT → buy PONS and airdrop it to PONZI holders; BURN_PCT → buy PONZI
// and burn it; the remainder (dev cut) stays in the wallet as native ETH for gas.
const rewardBuyPct = num(process.env.REWARD_BUY_PCT, 80);
const burnPct = num(process.env.BURN_PCT, 10);
if (rewardBuyPct < 0 || burnPct < 0 || rewardBuyPct + burnPct > 100) {
  throw new Error(
    `invalid split: REWARD_BUY_PCT(${rewardBuyPct}) + BURN_PCT(${burnPct}) must be within [0, 100]`
  );
}
const devPct = +(100 - rewardBuyPct - burnPct).toFixed(6);

const triggerMode = ['interval', 'accumulation'].includes(
  String(process.env.TRIGGER_MODE || 'interval').toLowerCase()
)
  ? String(process.env.TRIGGER_MODE || 'interval').toLowerCase()
  : 'interval';

const config = {
  port: num(process.env.PORT, 3000),
  dryRun: DRY_RUN,

  // Robinhood Chain mainnet defaults.
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: num(process.env.CHAIN_ID, 4663),
  explorerApi: (process.env.EXPLORER_API || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),

  wallet,
  walletIsEphemeral,

  // pons.family contracts (Robinhood Chain deployments; override per chain).
  ponsFactory: process.env.PONS_FACTORY || '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
  ponsLocker: process.env.PONS_LOCKER || '0x736D76699C26D0d966744cAe304C000d471f7F35',
  weth: process.env.WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  swapRouter: process.env.SWAP_ROUTER || '0xCaf681a66D020601342297493863E78C959E5cb2',
  // Protocol's share of each collectFees() payout (both fee sides); the creator
  // (this wallet) gets the remainder. Used only to estimate the claimable balance
  // for the trigger — the actual payout is measured from the receipt's logs.
  protocolFeeSharePct: num(process.env.PROTOCOL_FEE_SHARE_PCT, 10),

  // The PONZI token you launched on pons.family. Its creator fees fund the cycle.
  tokenAddress: lowerOrNull(process.env.TOKEN_ADDRESS),
  tokenSymbol: process.env.TOKEN_SYMBOL || 'PONZI',

  // ── Uniswap V4 — the stock buy path ──────────────────────────────────────
  // Robinhood stock tokens have NO V2 pairs and their V3 pools are empty; the
  // liquidity lives in the V4 singleton PoolManager. An EOA can't swap V4
  // directly (unlock/callback), so buys go through the UniversalRouter and are
  // priced by V4Quoter. These deployments are the ones wired to this PoolManager
  // (verified on-chain — other UniversalRouters on this chain point elsewhere).
  universalRouter: process.env.UNIVERSAL_ROUTER || '0xC6da9C87caE2fcecad79E22C398dE16BFAb0cFdA',
  v4Quoter: process.env.V4_QUOTER || '0x628c00B016415Ef530552063faE4154B0CdEb0Ac',
  poolManager: process.env.POOL_MANAGER || '0x8366a39CC670B4001A1121B8F6A443A643e40951',

  // Which stock tokens to buy + airdrop (symbols, comma-separated). Blank = the
  // whole verified registry (see src/evm/stocks.js).
  stocks: list(process.env.STOCKS),

  // Price-sanity bounds for a stock buy. Several V4 pools on this chain are
  // initialised but EMPTY and quote absurd prices (TSM implies ~$179,000,000 a
  // share against a real ~$408). The slippage floor cannot catch that, because
  // amountOutMinimum is derived from the same poisoned quote — so any implied
  // unit price outside this range means "broken pool", and the stock is skipped.
  maxImpliedPriceUsd: num(process.env.MAX_IMPLIED_PRICE_USD, 10000),
  minImpliedPriceUsd: num(process.env.MIN_IMPLIED_PRICE_USD, 0.01),

  // ── Split ────────────────────────────────────────────────────────────────
  rewardBuyPct, // % of each claim → buy STOCKS (airdropped to holders)
  burnPct, // % of each claim → buy PONZI and burn
  devPct, // remainder kept as native ETH (dev cut + gas)
  // false (default) → burn ONLY the BURN_PCT buyback. true → also burn the PONZI
  // token-side creator fees that accrue to the wallet on every claim (which is
  // what made a single cycle's burn far larger than the 2% buyback).
  burnTokenSideFees: bool(process.env.BURN_TOKEN_SIDE_FEES, false),
  slippagePct: num(process.env.SLIPPAGE_PCT, 5), // Uniswap V3 buy-swap slippage, percent
  gasReserveEth: num(process.env.GAS_RESERVE_ETH, 0.005), // native ETH never wrapped/spent on a buy
  deadAddress: lowerOrNull(process.env.DEAD_ADDRESS) || '0x000000000000000000000000000000000000dead',

  // ── Airdrop (PONS → PONZI holders) ──────────────────────────────────────────
  minHold: num(process.env.MIN_HOLD, 100000), // min PONZI balance to qualify
  rewardCapPct: num(process.env.REWARD_CAP_PCT, 0), // per-wallet weight cap, % of supply (0 = pure pro-rata)
  clusters: parseClusters(process.env.CLUSTERS), // wallet groups treated as one person for the cap
  airdropBatchSize: num(process.env.AIRDROP_BATCH_SIZE, 30), // max airdrop txs in flight (sliding window); also recipients per disperse batch
  airdropGasLimit: num(process.env.AIRDROP_GAS_LIMIT, 120000), // fixed gas per airdrop transfer (skips per-tx estimateGas)
  disperseAddress: lowerOrNull(process.env.DISPERSE_ADDRESS), // batch-transfer contract (null → pipelined transfers)
  // Extra owner addresses excluded from airdrops (pool, treasury, etc.), comma-separated.
  airdropExclude: (process.env.AIRDROP_EXCLUDE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ── Trigger ─────────────────────────────────────────────────────────────────
  // The scheduler ticks on POLL_SCHEDULE. TRIGGER_MODE decides the gate:
  //   'interval'     → fire on whatever has accrued every tick (default)
  //   'accumulation' → fire only once claimable >= CLAIM_EVERY_ETH
  triggerMode,
  pollSchedule: process.env.POLL_SCHEDULE || '*/5 * * * *',
  claimEveryEth: num(process.env.CLAIM_EVERY_ETH, 0.005),
  // DRY_RUN only: simulated ETH added to the fee vault each tick, so cycles have
  // something to claim without real fees.
  dryRunFeePerPoll: num(process.env.DRY_RUN_FEE_PER_POLL, 0.01),

  // DexScreener chain slug for /stats market data (graceful nulls until listed).
  dexscreenerChainId: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',

  // Storage (MongoDB)
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'ponsliqui',

  // CORS allowlist (comma-separated). Default: localhost dev origins. Set to your
  // frontend domain(s) in production, or "*" to allow any origin.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Secret protecting the POST control endpoints. Blank = open (dev); set in prod.
  apiKey: process.env.API_KEY || null,
};

module.exports = config;
