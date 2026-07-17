# robintrack

**Turns your pons.family token's creator fees into real tokenized-stock airdrops
for your holders — on Robinhood Chain.**

Every claim, the bot recycles your PONZI creator fees into three streams:

```
claim PONZI creator fees (WETH)  — collectFees() on the pons.family locker
  → unwrap to native ETH
  → 80%  buy STOCKS (Uniswap V4: NVDA, AAPL, TSLA, …)
         → airdrop each stock to PONZI holders (pro-rata, >= MIN_HOLD)
  →  5%  buy PONZI (Uniswap V3) → BURN it (0x…dEaD)
  → 15%  kept as native ETH (dev cut + gas)
```

Everything runs in `DRY_RUN=true` by default — all on-chain calls are simulated
and no funds are touched until you flip it off.

## Why Uniswap V4 (this part matters)

Robinhood **stock tokens are ordinary, freely transferable ERC-20s** (18 dp, no
allowlist/KYC), so airdropping them to holders is just `transfer`. *Buying* them
is the hard part, and the venue is not the obvious one — all verified on-chain:

| Venue | Reality |
|---|---|
| Uniswap **V2** | no pairs for the stock tokens at all |
| Uniswap **V3** | pools exist but **every one has `liquidity = 0`** (empty shells) |
| Uniswap **V4** | ✅ the real liquidity — the singleton `PoolManager` holds the stock reserves |

So the bot buys on **V4**. An EOA can't swap V4 directly (the PoolManager uses an
unlock/callback flow), so buys go through the **UniversalRouter** with a
`V4_SWAP` command, priced by **V4Quoter**. Each stock pools **directly against
native ETH**, so there is no wrapping and no USDG hop.

Only stocks with a **live native-ETH V4 pool** are in the registry
(`src/evm/stocks.js`) — each verified by a real quote:

**AAPL · AMD · AMZN · GOOGL · META · MSFT · NVDA · PLTR · SPCX · TSLA**

`BE, COIN, CRWV, INTC, MU, ORCL, SNDK, USAR` exist as tokens but have **no direct
ETH pool**, so they are deliberately excluded rather than failing every cycle.

> Addresses are pinned, never symbols — the chain has copycats squatting real
> tickers (there is a fake "SPCX" literally named *ScammingPeopleCashXtraction*).

## How the pons.family fee claim works

pons.family deploys each token into a Uniswap V3 pool and locks the LP in its
**PonsLaunchLocker**. `collectFees(token)` pulls the position's fees, takes the
protocol share, and pays the creator remainder to the token's fee recipient — the
**deployer**. So the operating wallet **must be the wallet that deployed PONZI on
pons.family**; the WETH lands there and the cycle unwraps it to native ETH for
the V4 buys.

## The reward leg, precisely

- The holder snapshot is taken **once** and reused for **every** stock — so all
  stocks use identical weights and nobody can shift their share between drops.
- Only what was **actually bought this cycle** is distributed, measured from the
  **balance delta** (never the router's return value), so a partial fill can't
  overstate a drop. A holder's own balance is never touched.
- Eligibility: `>= MIN_HOLD` PONZI. The operating wallet, dead address, pool,
  locker, factory, the V4 contracts, and the stock tokens are all excluded.
- A stock that fails (no pool, revert) is recorded and **skipped** — one bad
  stock must not cost the others their airdrop.

## Quick start

```bash
npm install
cp .env.example .env       # safe defaults: DRY_RUN=true, ephemeral wallet
npm test                   # 55 tests, in-memory MongoDB
npm start
```

## Config

| Env | Default | Meaning |
|---|---|---|
| `TOKEN_ADDRESS` | — | your PONZI token on pons.family (its fees fund everything) |
| `STOCKS` | *(blank)* | stocks to buy + airdrop; blank = the whole verified registry |
| `REWARD_BUY_PCT` | `80` | % of each claim → stocks (airdropped) |
| `BURN_PCT` | `5` | % of each claim → buy PONZI + burn |
| `MIN_HOLD` | `100000` | min PONZI balance to qualify for a drop |
| `REWARD_CAP_PCT` | `0` | optional per-wallet cap (anti-whale); 0 = off |
| `SLIPPAGE_PCT` | `5` | buy-swap slippage tolerance |
| `UNIVERSAL_ROUTER` / `V4_QUOTER` | RH deploys | the V4 plumbing (already wired) |

## Going live

1. Fill `.env`: `WALLET_PRIVATE_KEY` (the **deployer** of PONZI), `TOKEN_ADDRESS`,
   `MONGODB_URI`, `DRY_RUN=false`. Fund the wallet with native ETH for gas.
2. `node scripts/check.js` — read-only preflight.
3. `node scripts/run-once.js --confirm` — one full cycle, then `npm start`.

## Verified, not assumed

- **55/55 tests pass** (dry-run cycle: claim → buy 10 stocks → 10 airdrops → burn).
- The **V4 UniversalRouter encoding was validated against the live chain** by
  `staticCall`ing `execute()` for NVDA/AAPL/TSLA — it succeeds, so the swap path
  is real rather than theoretical (see `simulateBuy` in `src/evm/v4.js`).
