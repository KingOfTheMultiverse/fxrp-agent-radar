#!/usr/bin/env node
/** Writes web/data.json — the dashboard's data source. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, scanAgents, stressPath } from '../src/radar.mjs';

const conn = await connect();
const { agents, thresholds, prices } = await scanAgents(conn);
const block = await conn.provider.getBlockNumber();

const totalMintedUBA = agents.reduce((s, a) => s + a.mintedUBA, 0n);

const payload = {
  generatedAt: new Date().toISOString(),
  network: 'Coston2',
  chainId: 114,
  block,
  prices,
  totals: {
    agents: agents.length,
    healthy: agents.filter((a) => a.status === 'NORMAL').length,
    mintedXRP: Number(totalMintedUBA) / 1e6,
    mintedUsd: prices?.XRP ? (Number(totalMintedUBA) / 1e6) * prices.XRP.usd : null,
    freeLots: agents.reduce((s, a) => s + a.freeLots, 0),
  },
  thresholds: Object.fromEntries(
    Object.entries(thresholds).map(([k, v]) => [
      k,
      { ...v, minCollateralRatioBIPS: Number(v.minCollateralRatioBIPS), safetyMinCollateralRatioBIPS: Number(v.safetyMinCollateralRatioBIPS) },
    ])
  ),
  // Demonstrates the risk logic against a degrading agent — testnet agents are
  // all healthy, so the dangerous end of the curve is otherwise never visible.
  stress: agents.length ? { agent: agents[0].address, path: stressPath(agents[0]) } : null,
  agents: agents.map((a) => ({
    address: a.address,
    status: a.status,
    publiclyAvailable: a.publiclyAvailable,
    underlyingAddress: a.underlyingAddress,
    feeBIPS: a.feeBIPS,
    freeLots: a.freeLots,
    score: a.score,
    vaultSymbol: a.vaultSymbol,
    poolSymbol: a.poolSymbol,
    vaultCR: Number(a.vaultCollateralRatioBIPS) / 100,
    poolCR: Number(a.poolCollateralRatioBIPS) / 100,
    vaultMin: Number(a.vaultMinBIPS) / 100,
    poolMin: Number(a.poolMinBIPS) / 100,
    vaultBuffer: a.vaultBuffer,
    poolBuffer: a.poolBuffer,
    backingSurplus: a.backingSurplus,
    mintedXRP: Number(a.mintedUBA) / 1e6,
    mintedUsd: a.mintedUsd,
    underlyingXRP: Number(a.underlyingBalanceUBA) / 1e6,
    requiredXRP: Number(a.requiredUnderlyingBalanceUBA) / 1e6,
    warnings: a.warnings,
  })),
};

mkdirSync(new URL('../web', import.meta.url), { recursive: true });
writeFileSync(new URL('../web/data.json', import.meta.url), JSON.stringify(payload, null, 2));
console.log(`wrote web/data.json — ${agents.length} agents @ block ${block}`);
