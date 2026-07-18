'use strict';

// Sell the token-side creator fee (RIF) to ETH from the DISCLOSED fee-conversion
// wallet, and forward the ETH to the dev wallet. This is the sell leg of the
// burn/sell split — it is NEVER a "burn" and is reported as a dev fee.
//
// RIF is a pons.family launch: its liquidity is a Uniswap V3 pool (RIF/WETH)
// whose fee tier + token ordering come from the launch record. We quote by
// static-calling the router's exactInputSingle (amountOutMinimum=0), apply a
// slippage floor to the real swap, unwrap WETH → native ETH, then sweep to the
// dev wallet minus a gas reserve.

const { Contract, MaxUint256, parseEther, formatEther, formatUnits } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');
const { erc20, wethContract, getDecimals } = require('./erc20');
const { getLaunchedToken } = require('./pons');
const { sendTx } = require('./send');

// Uniswap V3 SwapRouter (original, with deadline in the struct). If the on-chain
// router is SwapRouter02 (no deadline), the probe in scripts/verify-sell-route.js
// will flag it and this ABI + the params object drop the `deadline` field.
const V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

/** Slippage floor: quotedRaw * (100 - slippagePct)%, in basis points. */
function computeMinOut(quotedRaw, slippagePct) {
  return (BigInt(quotedRaw) * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;
}

/** ETH to forward to the dev: balance minus the gas reserve (0 if not above it). */
function sweepValue(balanceWei, reserveEth) {
  const reserve = parseEther(String(reserveEth));
  const v = BigInt(balanceWei) - reserve;
  return v > 0n ? v : 0n;
}

/** exactInputSingle params for selling `token` → WETH on the launch pool. */
function sellParams(launch, token, amountIn, minOut, recipient, deadline) {
  return {
    tokenIn: token,
    tokenOut: launch.pairedToken,
    fee: launch.poolFee,
    recipient,
    deadline,
    amountIn: BigInt(amountIn),
    amountOutMinimum: BigInt(minOut),
    sqrtPriceLimitX96: 0n,
  };
}

const sellerSigner = config.sellerWallet ? config.sellerWallet.connect(provider) : null;

function fakeSig() {
  return `sell_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Sell `amountRaw` of `token` to ETH from the seller wallet and forward the ETH
 * to config.devWallet. Best-effort caller handles failures.
 * @returns {Promise<{signature, soldRaw: bigint, sold: number, ethReceived: number, ethToDev: number, simulated: boolean}>}
 */
async function sellTokenForEth(token, amountRaw) {
  const amount = BigInt(amountRaw || '0');

  if (config.dryRun) {
    // Simulate ~1 ETH per 1000 RIF so a dry cycle has plausible numbers.
    const ethReceived = Number(amount) / 1e18 / 1000;
    const ethToDev = Math.max(0, ethReceived - config.sellerGasReserveEth);
    return {
      signature: fakeSig(),
      soldRaw: amount,
      sold: Number(amount) / 1e18,
      ethReceived,
      ethToDev,
      simulated: true,
    };
  }

  if (amount <= 0n) throw new Error(`nothing to sell (amount ${amountRaw})`);
  if (!sellerSigner) throw new Error('SELLER_PRIVATE_KEY not configured');

  // (Live path implemented in Task 5.)
  throw new Error('live sell path not implemented yet');
}

module.exports = { computeMinOut, sweepValue, sellParams, sellTokenForEth, sellerSigner, V3_ROUTER_ABI };
