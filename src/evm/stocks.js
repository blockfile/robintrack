'use strict';

// The Robinhood stock tokens this bot buys and airdrops.
//
// Every entry below was verified on-chain: each has a LIVE Uniswap V4 pool
// against NATIVE ETH (fee 50000 / tickSpacing 1000 / no hooks) and returned a
// real quote. The other Robinhood stock tokens (BE, COIN, CRWV, INTC, MU, ORCL,
// SNDK, USAR) exist but have NO direct ETH pool — they'd need a USDG hop, so
// they're deliberately left out rather than failing every cycle.
//
// Pin addresses, never symbols: the chain has copycat tokens squatting real
// tickers (there is a fake "SPCX" literally named ScammingPeopleCashXtraction).

const { ZeroAddress } = require('ethers');

const V4_FEE = 50000; // 5% — the tier every stock/ETH pool uses
const V4_TICK_SPACING = 1000;

const REGISTRY = [
  { symbol: 'AAPL', name: 'Apple', token: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' },
  { symbol: 'AMD', name: 'AMD', token: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC' },
  { symbol: 'AMZN', name: 'Amazon', token: '0x12f190a9F9d7D37a250758b26824B97CE941bF54' },
  { symbol: 'GOOGL', name: 'Alphabet', token: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3' },
  { symbol: 'META', name: 'Meta', token: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35' },
  { symbol: 'MSFT', name: 'Microsoft', token: '0xe93237C50D904957Cf27E7B1133b510C669c2e74' },
  { symbol: 'NVDA', name: 'NVIDIA', token: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' },
  { symbol: 'PLTR', name: 'Palantir', token: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A' },
  { symbol: 'SPCX', name: 'SpaceX', token: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa' },
  { symbol: 'TSLA', name: 'Tesla', token: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d' },
].map((s) => ({
  ...s,
  token: s.token.toLowerCase(),
  fee: V4_FEE,
  tickSpacing: V4_TICK_SPACING,
  hooks: ZeroAddress,
  decimals: 18, // Robinhood stock tokens are 18-decimal ERC-20s
}));

const BY_SYMBOL = new Map(REGISTRY.map((s) => [s.symbol, s]));

/**
 * The stocks a cycle should buy: the configured STOCKS symbols, or all of the
 * registry when unset. Throws on an unknown symbol rather than silently paying
 * out fewer stocks than the operator asked for.
 * @param {string[]} symbols
 * @returns {object[]}
 */
function resolveStocks(symbols) {
  if (!symbols || symbols.length === 0) return [...REGISTRY];
  return symbols.map((raw) => {
    const sym = String(raw).trim().toUpperCase();
    const s = BY_SYMBOL.get(sym);
    if (!s) {
      throw new Error(`unknown stock "${sym}" — known: ${[...BY_SYMBOL.keys()].join(', ')}`);
    }
    return s;
  });
}

module.exports = { REGISTRY, BY_SYMBOL, resolveStocks, V4_FEE, V4_TICK_SPACING };
