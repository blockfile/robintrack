'use strict';

// Buys on Uniswap V3 (SwapRouter02) — pons.family tokens trade in ordinary V3
// pools (1% fee tier by default), so a plain exactInputSingle WETH→token swap
// is the whole buy path. The claim pays the wallet in WETH, which is exactly
// the router's input token; any native-ETH shortfall is wrapped on the fly.

const { Contract, parseEther, formatEther } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { wethContract, getDecimals, readTokenBalance } = require('./erc20');
const { launcherToken } = require('./pons');

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

const DEFAULT_POOL_FEE = 10000; // pons.family launches on the 1% fee tier
const FEE_TIERS = [500, 3000, 10000]; // standard V3 tiers a token may pool on
const BUY_ATTEMPTS = 3;

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The token's V3 fee tier (from its pons.family launcher fields), defaulting to 1%. */
async function resolvePoolFee(token) {
  try {
    return Number(await launcherToken(token).poolFee());
  } catch (_err) {
    return DEFAULT_POOL_FEE; // not a pons.family launcher token — assume the 1% tier
  }
}

/**
 * Quote the swap on every standard fee tier (by static-calling the swap itself)
 * and return the best { fee, quoted }, or null when no tier has a pool. Tokens
 * can pool on several tiers with wildly different depth, and a single tier's
 * price can be transiently manipulated — the best CURRENT quote is the only
 * reliable pool selector.
 */
async function bestQuote(router, baseParams) {
  let best = null;
  for (const fee of FEE_TIERS) {
    try {
      const quoted = await router.exactInputSingle.staticCall({ ...baseParams, fee });
      if (!best || quoted > best.quoted) best = { fee, quoted };
    } catch (_err) {
      // no pool (or no liquidity) at this tier
    }
  }
  return best;
}

/**
 * Ensure the wallet holds >= amountIn WETH, wrapping native ETH to cover a
 * shortfall — but never dipping into the gas reserve: the wrap itself plus the
 * approve/swap/airdrop txs that follow all need native ETH.
 */
async function ensureWethBalance(amountIn) {
  const weth = wethContract(wallet);
  const bal = await weth.balanceOf(wallet.address);
  if (bal >= amountIn) return;
  const shortfall = amountIn - bal;
  const gasReserve = parseEther(String(config.gasReserveEth));
  const native = await provider.getBalance(wallet.address);
  if (native < shortfall + gasReserve) {
    throw new Error(
      `insufficient WETH+ETH: need ${formatEther(amountIn)} WETH (+${formatEther(gasReserve)} ETH gas reserve), have ${formatEther(bal)} WETH + ${formatEther(native)} ETH`
    );
  }
  const tx = await weth.deposit({ value: shortfall });
  await tx.wait();
  console.log(`[tx] wrap ${formatEther(shortfall)} ETH → WETH: ${tx.hash}`);
}

/** Approve the router to spend WETH once (max approval, skipped when already set). */
async function ensureRouterAllowance(amountIn) {
  const weth = wethContract(wallet);
  const allowance = await weth.allowance(wallet.address, config.swapRouter);
  if (allowance >= amountIn) return;
  const tx = await weth.approve(config.swapRouter, (1n << 256n) - 1n);
  await tx.wait();
  console.log(`[tx] approve router for WETH: ${tx.hash}`);
}

/**
 * Buy `token` with `ethAmount` (spent as WETH) via exactInputSingle.
 * @returns {Promise<{signature, tokensBought, tokensBoughtRaw, baseDecimals, simulated}>}
 */
async function buyToken(token, ethAmount) {
  if (config.dryRun) {
    const baseDecimals = 18;
    const tokensBought = +(ethAmount * 1_000_000 * (0.97 + Math.random() * 0.06)).toFixed(0);
    return {
      signature: fakeSig('buy'),
      tokensBought,
      tokensBoughtRaw: (BigInt(tokensBought) * 10n ** BigInt(baseDecimals)).toString(),
      baseDecimals,
      simulated: true,
    };
  }

  const amountIn = parseEther(String(ethAmount));
  if (amountIn <= 0n) throw new Error(`invalid buy amount: ${ethAmount}`);
  if (!(config.slippagePct >= 0 && config.slippagePct < 100)) {
    throw new Error(`SLIPPAGE_PCT must be in [0, 100): ${config.slippagePct}`);
  }

  await ensureWethBalance(amountIn);
  await ensureRouterAllowance(amountIn);

  const router = new Contract(config.swapRouter, ROUTER_ABI, wallet);
  const baseParams = {
    tokenIn: config.weth,
    tokenOut: token,
    recipient: wallet.address,
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  };
  const baseDecimals = await getDecimals(token);

  // Re-quote across all tiers on every attempt and bound the send by the
  // configured slippage. A one-block price spike (bot volume, sandwich) makes
  // the send revert on the min-output check — that protection is correct, but
  // it must not kill the cycle: wait out the spike and try again fresh.
  let lastErr;
  for (let attempt = 1; attempt <= BUY_ATTEMPTS; attempt++) {
    const best = await bestQuote(router, baseParams);
    if (!best) throw new Error(`no usable pool for ${token} on fee tiers ${FEE_TIERS.join('/')}`);
    const params = {
      ...baseParams,
      fee: best.fee,
      amountOutMinimum:
        (best.quoted * BigInt(Math.round((100 - config.slippagePct) * 100))) / 10000n,
    };

    try {
      const balBefore = await readTokenBalance(token, wallet.address);
      const tx = await router.exactInputSingle(params);
      await tx.wait();
      console.log(`[tx] buy ${token} with ${ethAmount} WETH (tier ${best.fee}): ${tx.hash}`);
      const balAfter = await readTokenBalance(token, wallet.address);

      const boughtRaw = balAfter - balBefore;
      return {
        signature: tx.hash,
        tokensBought: Number(boughtRaw) / 10 ** baseDecimals,
        tokensBoughtRaw: boughtRaw.toString(),
        baseDecimals,
        simulated: false,
      };
    } catch (err) {
      lastErr = err;
      console.warn(
        `[buy] attempt ${attempt}/${BUY_ATTEMPTS} reverted on tier ${best.fee} — requoting${attempt < BUY_ATTEMPTS ? ' after 3s' : ''}`
      );
      if (attempt < BUY_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

module.exports = { buyToken, resolvePoolFee, DEFAULT_POOL_FEE };
