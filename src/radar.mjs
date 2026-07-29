/**
 * FXRP Agent Radar — risk tooling for Flare FAssets.
 *
 * FAssets splits the risk in two, and the halves are not symmetric:
 *
 *   Minting  — `reserveCollateral(address _agentVault, ...)` takes an agent, so the
 *              user chooses, and agent scoring is what helps.
 *   Redeeming — `redeem(uint256 _lots, ...)` takes no agent. Tickets are consumed from
 *              a global FIFO queue, so the user gets whoever is at its head and can
 *              only look ahead, not choose.
 *
 * The AssetManager exposes 40 raw fields per agent and no judgement. Two risks are
 * invisible:
 *
 *  1. Liquidation proximity — a raw collateral ratio means nothing without its
 *     threshold, and vault and pool thresholds differ (120% vs 150%).
 *  2. Redemption default — if an agent's underlying XRP no longer covers what it owes,
 *     redemption pays collateral at `redemptionDefaultFactorVaultCollateralBIPS`
 *     instead of XRP. A redeemer who wanted XRP does not get XRP.
 *
 * This module reads live chain state and turns both into comparable numbers.
 */
import pkg from '@flarenetwork/flare-periphery-contract-artifacts';
import { ethers } from 'ethers';

const { coston2 } = pkg;

export const COSTON2_RPC = 'https://coston2-api.flare.network/ext/C/rpc';
export const ASSET_MANAGER_FXRP = '0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA';


/** Agent status codes from the FAssets AssetManager. */
export const AGENT_STATUS = {
  0: 'NORMAL',
  1: 'CCB',            // collateral call band — grace period before liquidation
  2: 'LIQUIDATION',
  3: 'FULL_LIQUIDATION',
  4: 'DESTROYING',
};

export const FTSO_V2 = '0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d';

/** FTSOv2 feed ids (bytes21, category 01 = crypto). */
export const FEED_IDS = {
  FLR: '0x01464c522f55534400000000000000000000000000',
  XRP: '0x015852502f55534400000000000000000000000000',
};

const FTSO_ABI = [
  'function getFeedById(bytes21 _feedId) external payable returns (uint256 value, int8 decimals, uint64 timestamp)',
];

export async function connect(rpc = COSTON2_RPC) {
  const provider = new ethers.JsonRpcProvider(rpc);
  const abi = coston2.interfaceToAbi('IAssetManager', 'coston2');
  const assetManager = new ethers.Contract(ASSET_MANAGER_FXRP, abi, provider);
  const ftso = new ethers.Contract(FTSO_V2, FTSO_ABI, provider);
  return { provider, abi, assetManager, ftso };
}

/**
 * Live USD prices from Flare's FTSOv2 enshrined oracle.
 * `getFeedById` is payable, so it must be read via staticCall rather than a tx.
 */
export async function loadPrices({ ftso }) {
  const out = {};
  for (const [sym, id] of Object.entries(FEED_IDS)) {
    const [value, decimals, timestamp] = await ftso.getFeedById.staticCall(id);
    out[sym] = {
      usd: Number(value) / 10 ** Number(decimals),
      updatedAt: Number(timestamp),
    };
  }
  return out;
}

/** Decodes a solidity struct tuple into a plain object using its ABI fragment. */
function decodeStruct(abi, fnName, value) {
  const comps = abi.find((f) => f.name === fnName).outputs[0].components;
  return Object.fromEntries(comps.map((c, i) => [c.name, value[i]]));
}

/** Minimum + safety collateral ratios, keyed by collateral token address. */
export async function loadThresholds({ assetManager, abi }) {
  const raw = await assetManager.getCollateralTypes();
  const comps = abi.find((f) => f.name === 'getCollateralTypes').outputs[0].components;
  const byToken = {};
  for (const t of raw) {
    const o = Object.fromEntries(comps.map((c, i) => [c.name, t[i]]));
    byToken[String(o.token).toLowerCase()] = {
      symbol: o.tokenFtsoSymbol,
      collateralClass: Number(o.collateralClass),
      minCollateralRatioBIPS: BigInt(o.minCollateralRatioBIPS),
      safetyMinCollateralRatioBIPS: BigInt(o.safetyMinCollateralRatioBIPS),
    };
  }
  return byToken;
}

/**
 * Buffer above the liquidation threshold, as a fraction of that threshold.
 * 0 means sitting exactly on the line; 1.0 means double the required ratio.
 */
export function collateralBuffer(actualBIPS, minBIPS) {
  if (minBIPS === 0n) return 0;
  return Number(actualBIPS - minBIPS) / Number(minBIPS);
}

/**
 * Fraction of owed underlying XRP the agent actually holds, minus 1.
 * Negative means the agent cannot honour redemptions in XRP today.
 */
export function backingSurplus(underlyingUBA, requiredUBA) {
  if (requiredUBA === 0n) return 1; // owes nothing, fully backed by definition
  return Number(underlyingUBA - requiredUBA) / Number(requiredUBA);
}

/**
 * Composite 0-100 score. Weighted toward safety over price: a cheap agent that
 * defaults on redemption costs the user far more than a few basis points of fee.
 */
export function scoreAgent(a) {
  if (a.status !== 'NORMAL') return 0; // in CCB or liquidation — never route here

  const safety = Math.max(0, Math.min(1, Math.min(a.vaultBuffer, a.poolBuffer) / 1.0));
  const backing = Math.max(0, Math.min(1, a.backingSurplus / 0.5));
  const capacity = Math.max(0, Math.min(1, a.freeLots / 100));
  const cheapness = Math.max(0, Math.min(1, 1 - a.feeBIPS / 100));

  return Math.round(100 * (0.4 * safety + 0.3 * backing + 0.2 * capacity + 0.1 * cheapness));
}

/** Human-readable warnings a redeemer should see before committing. */
export function warnings(a) {
  const w = [];
  if (a.status !== 'NORMAL') w.push(`agent status ${a.status} — do not route`);
  if (a.backingSurplus < 0) w.push('underlying XRP does not cover obligations — redemption may default to collateral');
  else if (a.backingSurplus < 0.05) w.push('thin XRP backing (<5% surplus) — elevated redemption-default risk');
  if (a.vaultBuffer < 0.1) w.push('vault collateral within 10% of liquidation threshold');
  if (a.poolBuffer < 0.1) w.push('pool collateral within 10% of liquidation threshold');
  if (a.freeLots === 0) w.push('no free lots — cannot mint against this agent');
  return w;
}

/** Reads every agent and returns them scored, best first. */
export async function scanAgents(conn) {
  const { assetManager, abi } = conn;
  const thresholds = await loadThresholds(conn);
  // Prices are a nice-to-have; a stale oracle must not block the risk read.
  let prices = null;
  try {
    prices = await loadPrices(conn);
  } catch (e) {
    prices = { error: String(e.message ?? e) };
  }
  const [addresses] = await assetManager.getAllAgents(0, 100);

  const agents = [];
  for (const addr of addresses) {
    const info = decodeStruct(abi, 'getAgentInfo', await assetManager.getAgentInfo(addr));
    const vaultT = thresholds[String(info.vaultCollateralToken).toLowerCase()];
    const poolT = thresholds[String(info.poolWNatToken).toLowerCase()];

    const a = {
      address: addr,
      status: AGENT_STATUS[Number(info.status)] ?? `UNKNOWN(${info.status})`,
      publiclyAvailable: info.publiclyAvailable,
      underlyingAddress: info.underlyingAddressString,
      feeBIPS: Number(info.feeBIPS),
      freeLots: Number(info.freeCollateralLots),
      vaultCollateralRatioBIPS: BigInt(info.vaultCollateralRatioBIPS),
      poolCollateralRatioBIPS: BigInt(info.poolCollateralRatioBIPS),
      vaultMinBIPS: vaultT?.minCollateralRatioBIPS ?? 0n,
      poolMinBIPS: poolT?.minCollateralRatioBIPS ?? 0n,
      vaultSymbol: vaultT?.symbol ?? '?',
      poolSymbol: poolT?.symbol ?? '?',
      mintedUBA: BigInt(info.mintedUBA),
      underlyingBalanceUBA: BigInt(info.underlyingBalanceUBA),
      requiredUnderlyingBalanceUBA: BigInt(info.requiredUnderlyingBalanceUBA),
      liquidationStartTimestamp: Number(info.liquidationStartTimestamp),
    };

    a.vaultBuffer = collateralBuffer(a.vaultCollateralRatioBIPS, a.vaultMinBIPS);
    a.poolBuffer = collateralBuffer(a.poolCollateralRatioBIPS, a.poolMinBIPS);
    a.backingSurplus = backingSurplus(a.underlyingBalanceUBA, a.requiredUnderlyingBalanceUBA);
    // Size the exposure in dollars via FTSO so risk is comparable across agents.
    a.mintedUsd = prices?.XRP ? (Number(a.mintedUBA) / 1e6) * prices.XRP.usd : null;
    a.score = scoreAgent(a);
    a.warnings = warnings(a);
    agents.push(a);
  }

  // Genuinely safe agents legitimately tie on score — the model should not invent
  // precision that isn't there. Break ties on what actually differs: price, then capacity.
  agents.sort((x, y) => y.score - x.score || x.feeBIPS - y.feeBIPS || y.freeLots - x.freeLots);
  return { agents, thresholds, prices };
}

/**
 * Walks the FIFO redemption queue to find who will actually serve a redemption.
 *
 * `redeem()` takes no agent argument — tickets are consumed in order, so a redeemer
 * cannot choose. What they *can* do is look ahead: this maps `lots` onto the queue and
 * reports the share each agent will fill and how much of it sits with agents whose
 * underlying XRP does not cover what they owe. That portion is the part likely to pay
 * out in collateral rather than XRP.
 *
 * A single redemption consumes at most `maxRedeemedTickets` tickets — the protocol caps
 * this to bound gas. A request spanning more tickets than that is only partly filled in
 * one transaction, so the cap is modelled here rather than assumed away.
 *
 * @param queue    [{ agentVault, ticketValueUBA }] in queue order
 * @param byAgent  address (lowercased) -> scanned agent
 * @param lots     lots the user intends to redeem
 * @param lotSizeUBA  UBA per lot
 * @param maxRedeemedTickets  protocol cap on tickets consumed per redemption
 */
export function previewRedemption(queue, byAgent, lots, lotSizeUBA, maxRedeemedTickets = 20) {
  let remaining = BigInt(lots) * BigInt(lotSizeUBA);
  const requested = remaining;
  const fills = new Map();
  let ticketsUsed = 0;

  for (const t of queue) {
    if (remaining <= 0n || ticketsUsed >= maxRedeemedTickets) break;
    const take = t.ticketValueUBA < remaining ? t.ticketValueUBA : remaining;
    const key = String(t.agentVault).toLowerCase();
    fills.set(key, (fills.get(key) ?? 0n) + take);
    remaining -= take;
    ticketsUsed++;
  }
  const cappedByTickets = remaining > 0n && ticketsUsed >= maxRedeemedTickets;

  const filled = requested - remaining;
  const rows = [...fills.entries()].map(([addr, uba]) => {
    const agent = byAgent[addr];
    return {
      address: agent?.address ?? addr,
      uba,
      xrp: Number(uba) / 1e6,
      share: filled > 0n ? Number(uba) / Number(filled) : 0,
      backingSurplus: agent?.backingSurplus ?? null,
      status: agent?.status ?? 'UNKNOWN',
      underBacked: agent ? agent.backingSurplus < 0 : null,
    };
  }).sort((a, b) => b.share - a.share);

  const atRisk = rows.filter((r) => r.underBacked).reduce((s, r) => s + r.uba, 0n);

  return {
    requestedXRP: Number(requested) / 1e6,
    filledXRP: Number(filled) / 1e6,
    shortfallXRP: Number(remaining) / 1e6,
    ticketsUsed,
    maxRedeemedTickets,
    // Distinguishes "the queue ran out" from "the per-transaction ticket cap was hit" —
    // the second is recoverable by redeeming again, the first is not.
    cappedByTickets,
    fills: rows,
    atRiskXRP: Number(atRisk) / 1e6,
    atRiskShare: filled > 0n ? Number(atRisk) / Number(filled) : 0,
  };
}

/** Reads a single named field out of AssetManager settings. */
export async function getSetting({ assetManager, abi }, name) {
  const raw = await assetManager.getSettings();
  const comps = abi.find((f) => f.name === 'getSettings').outputs[0].components;
  const i = comps.findIndex((c) => c.name === name);
  if (i === -1) throw new Error(`unknown setting: ${name}`);
  return raw[i];
}

/** Reads the redemption queue, paging until exhausted or `max` tickets collected. */
export async function loadRedemptionQueue({ assetManager }, max = 200) {
  const out = [];
  let cursor = 0n;
  while (out.length < max) {
    const [tickets, next] = await assetManager.redemptionQueue(cursor, 50);
    for (const t of tickets) out.push({ agentVault: t[1], ticketValueUBA: BigInt(t[2]) });
    if (tickets.length === 0 || next === 0n) break;
    cursor = next;
  }
  return out;
}

/**
 * Replays an agent's score as its collateral and backing degrade.
 *
 * Live testnet agents are all heavily over-collateralised, so the risk logic never
 * fires against real data. This walks the same scoring functions down a stress path
 * so the behaviour at the dangerous end is demonstrable and reviewable. Purely
 * derived from the agent's real starting state — no chain writes.
 */
export function stressPath(agent, steps = 6) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps; // 0 = today, 1 = at the liquidation line
    const probe = {
      ...agent,
      vaultBuffer: agent.vaultBuffer * (1 - t),
      poolBuffer: agent.poolBuffer * (1 - t),
      // Backing decays past zero so the redemption-default branch is exercised.
      backingSurplus: agent.backingSurplus * (1 - t) - 0.1 * t,
    };
    probe.score = scoreAgent(probe);
    probe.warnings = warnings(probe);
    out.push({
      stress: t,
      vaultBuffer: probe.vaultBuffer,
      poolBuffer: probe.poolBuffer,
      backingSurplus: probe.backingSurplus,
      score: probe.score,
      warnings: probe.warnings,
    });
  }
  return out;
}

/** Best agent able to serve `lots`, or null if none qualify. */
export function bestAgentForLots(agents, lots) {
  return agents.find((a) => a.status === 'NORMAL' && a.publiclyAvailable && a.freeLots >= lots) ?? null;
}

export const fmt = {
  pct: (x) => `${(x * 100).toFixed(1)}%`,
  bipsPct: (b) => `${(Number(b) / 100).toFixed(1)}%`,
  xrp: (uba) => (Number(uba) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 }),
};
