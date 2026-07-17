'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { parseEther, formatUnits } = require('ethers');
const { claimCreatorFees } = require('../evm/pons');
const { buyToken } = require('../evm/uniswap');
const { burnToken } = require('../evm/burn');
const { getWethBalanceEth, unwrapAllWeth, getTokenSupplyRaw, readTokenBalance } = require('../evm/erc20');
const { snapshotEligibleHolders } = require('../evm/holders');
const { buildExcludeSet } = require('../evm/exclude');
const { computeWeightedAllocations } = require('../services/distribution');
const { airdropToken } = require('../evm/airdrop');
const { resolveStocks } = require('../evm/stocks');
const { buyStockWithEth } = require('../evm/v4');

/**
 * Reward leg: split `ethAmount` across the configured stocks, buy each on
 * Uniswap V4 with native ETH, and airdrop each stock pro-rata to eligible
 * holders of `holderToken` (PONZI).
 *
 * The holder snapshot is taken ONCE and reused for every stock, so all stocks
 * use identical weights and a holder can't shift their share between drops.
 * Only what was actually bought this cycle is distributed (measured from the
 * balance delta), never a holder's own balance.
 *
 * A stock that fails (no pool, revert) is recorded and skipped — one bad stock
 * must not cost the others their airdrop.
 */
async function runRewardLeg(cycleId, { holderToken, ethAmount, minHold, capPct, clusters }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  const stocks = resolveStocks(config.stocks);
  if (!stocks.length) throw new Error('no stocks configured');

  // Snapshot once; every stock is weighted identically off it.
  const minHoldRaw = (BigInt(Math.trunc(minHold)) * 10n ** 18n).toString(); // PONZI: 18 decimals
  const exclude = await buildExcludeSet(holderToken);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: holderToken, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${minHold}) of ${totalHolders} total`);
  if (!holders.length) {
    log('no eligible holders — skipping the stock buys (nothing to airdrop to)');
    return { sent: 0, failed: 0, eligibleHolders: 0, totalHolders, stocks: [] };
  }

  const supplyRaw = capPct == null ? null : (await getTokenSupplyRaw(holderToken)).toString();
  const perStockWei = parseEther(String(ethAmount)) / BigInt(stocks.length);
  log(`buying ${stocks.length} stocks with ${ethAmount} ETH (${formatUnits(perStockWei, 18)} each): ${stocks.map((s) => s.symbol).join(', ')}`);

  let sent = 0;
  let failed = 0;
  const results = [];

  for (const stock of stocks) {
    try {
      const buy = await buyStockWithEth(stock, perStockWei);
      const boughtUi = Number(formatUnits(buy.boughtRaw, stock.decimals));
      await repo.addStep({
        cycleId,
        name: 'buy',
        status: 'ok',
        signature: buy.signature,
        detail: { leg: 'reward', stock: stock.symbol, token: stock.token, ethSpent: Number(formatUnits(perStockWei, 18)), tokensBought: boughtUi },
      });

      const allocations = computeWeightedAllocations(holders, buy.boughtRaw.toString(), { capPct, supplyRaw, clusters });
      const air = await airdropToken({ rewardToken: stock.token, allocations, cycleId });
      await repo.addStep({
        cycleId,
        name: 'airdrop',
        status: air.failed ? 'failed' : 'ok',
        detail: { stock: stock.symbol, token: stock.token, recipients: allocations.length, sent: air.sent, failed: air.failed },
      });
      sent += air.sent;
      failed += air.failed;
      results.push({ symbol: stock.symbol, bought: boughtUi, sent: air.sent, failed: air.failed });
      log(`${stock.symbol}: bought ${boughtUi} → airdrop sent=${air.sent} failed=${air.failed}`);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      await repo.addStep({ cycleId, name: 'buy', status: 'failed', detail: { leg: 'reward', stock: stock.symbol, token: stock.token, message } });
      results.push({ symbol: stock.symbol, error: message });
      log(`${stock.symbol}: SKIPPED — ${message}`);
    }
  }

  return { sent, failed, eligibleHolders: holders.length, totalHolders, stocks: results };
}

/**
 * One reward-and-burn cycle (fired by the scheduler; skipped upstream when
 * nothing is claimable):
 *
 *   claim PONZI creator fees from the pons.family locker (paid in WETH)
 *     → REWARD_BUY_PCT: buy PONS and airdrop it to PONZI holders (pro-rata)
 *     → BURN_PCT:       buy PONZI and burn it (+ any PONZI token-side fees)
 *     → remainder:      unwrap the leftover WETH to native ETH (dev cut + gas)
 *
 * Each step is recorded; a thrown step fails the cycle without crashing.
 * @returns {Promise<object>} the persisted cycle (with steps)
 */
async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS (PONZI) is required');

    // 1. Claim creator fees (WETH).
    const claim = await claimCreatorFees();
    await repo.addStep({ cycleId: id, name: 'claim', status: 'ok', signature: claim.signature, detail: { ethClaimed: claim.ethClaimed } });
    log(`claimed ${claim.ethClaimed} ETH`);

    // Spend the wallet's WHOLE WETH balance (this claim plus any residue). In
    // DRY_RUN there is no real WETH, so use the simulated claim amount.
    const claimed = claim.ethClaimed;
    const walletWeth = config.dryRun ? claimed : await getWethBalanceEth().catch(() => claimed);
    if (!(walletWeth > 0)) {
      await repo.finishCycle(id, { status: 'skipped', eth_claimed: claimed, note: 'nothing claimed' });
      log('skipped: nothing to work with');
      return repo.getCycleWithSteps(id);
    }

    // The claim lands as WETH, but the V4 stock pools price against NATIVE ETH —
    // so unwrap up front and let the reward leg spend ETH directly. The V3 burn
    // leg re-wraps only what it needs.
    if (!config.dryRun) {
      await unwrapAllWeth().catch((err) => log(`unwrap before stock buys failed (non-fatal): ${err.message}`));
    }

    const eth = (pct) => +(walletWeth * (pct / 100)).toFixed(9);
    const rewardEth = eth(config.rewardBuyPct);
    const burnEth = eth(config.burnPct);
    const devEth = +(walletWeth - rewardEth - burnEth).toFixed(9);
    log(`split: ${rewardEth} → stocks (${config.rewardBuyPct}%), ${burnEth} → ${config.tokenSymbol} burn (${config.burnPct}%), keep ${devEth} for dev/gas`);

    // 2. Reward leg — buy stocks on V4 + airdrop each to PONZI holders.
    let reward = { sent: 0, failed: 0, eligibleHolders: 0, totalHolders: 0, stocks: [] };
    if (rewardEth > 0) {
      reward = await runRewardLeg(id, {
        holderToken: config.tokenAddress,
        ethAmount: rewardEth,
        minHold: config.minHold,
        capPct: config.rewardCapPct > 0 ? config.rewardCapPct : null,
        clusters: config.clusters,
      });
    }

    // 3. Burn leg — buy PONZI with burnEth and burn it. By default burn ONLY the
    //    buyback; set BURN_TOKEN_SIDE_FEES=true to also burn the PONZI token-side
    //    creator fees that accrue to the wallet each claim.
    let burned = 0;
    let burnSig = null;
    if (burnEth > 0) {
      const buyBurn = await buyToken(config.tokenAddress, burnEth);
      await repo.addStep({ cycleId: id, name: 'buy', status: 'ok', signature: buyBurn.signature, detail: { leg: 'burn', token: config.tokenAddress, ethSpent: burnEth, tokensBought: buyBurn.tokensBought } });
      const toBurnRaw = config.dryRun || !config.burnTokenSideFees
        ? buyBurn.tokensBoughtRaw
        : (await readTokenBalance(config.tokenAddress, config.wallet.address)).toString();
      const burn = await burnToken(config.tokenAddress, toBurnRaw);
      await repo.addStep({ cycleId: id, name: 'burn', status: 'ok', signature: burn.signature, detail: { tokensBurned: burn.burned, burnedRaw: burn.burnedRaw, deadAddress: burn.deadAddress } });
      burned = burn.burned;
      burnSig = burn.signature;
      log(`burned ${burn.burned} ${config.tokenSymbol} → ${burn.deadAddress}`);
    }

    // 4. Dev cut — unwrap the WETH remainder to native ETH (kept for gas + dev).
    //    Best-effort — never fails the cycle.
    await unwrapAllWeth().catch((err) => log(`unwrap remainder failed (non-fatal): ${err.message}`));

    // 5. Done.
    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'stocks-reward-burn',
      eth_claimed: claimed,
      eth_spent_buy: rewardEth,
      tokens_burned: burned,
      burn_sig: burnSig,
      eligible_holders: reward.eligibleHolders,
      total_holders: reward.totalHolders,
      stocks: reward.stocks,
      note: `airdropped ${reward.stocks.filter((s) => !s.error).length} stocks, ${reward.sent} sends (${reward.failed} failed)`,
    });
    log('complete (stocks-reward-burn)');
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle, runRewardLeg };
