#!/usr/bin/env node
/**
 * FXRP Agent Radar CLI.
 *
 *   node bin/radar.mjs              ranked agent table
 *   node bin/radar.mjs --lots 5     also pick the best agent for 5 lots
 *   node bin/radar.mjs --json       machine-readable output
 */
import {
  connect, scanAgents, bestAgentForLots, fmt,
  loadRedemptionQueue, previewRedemption, getSetting,
} from '../src/radar.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};

const conn = await connect();
const { agents } = await scanAgents(conn);

if (argv.includes('--json')) {
  const plain = agents.map((a) => ({
    ...a,
    vaultCollateralRatioBIPS: a.vaultCollateralRatioBIPS.toString(),
    poolCollateralRatioBIPS: a.poolCollateralRatioBIPS.toString(),
    vaultMinBIPS: a.vaultMinBIPS.toString(),
    poolMinBIPS: a.poolMinBIPS.toString(),
    mintedUBA: a.mintedUBA.toString(),
    underlyingBalanceUBA: a.underlyingBalanceUBA.toString(),
    requiredUnderlyingBalanceUBA: a.requiredUnderlyingBalanceUBA.toString(),
  }));
  console.log(JSON.stringify(plain, null, 2));
  process.exit(0);
}

console.log('\nFXRP Agent Radar — Flare FAssets (Coston2)\n');
console.log(
  ['score', 'status', 'fee', 'lots', 'vaultCR', 'buffer', 'poolCR', 'buffer', 'XRP backing', 'agent']
    .map((h, i) => h.padStart([5, 10, 6, 6, 8, 7, 8, 7, 12, 0][i] || 0))
    .join(' ')
);
console.log('-'.repeat(118));

for (const a of agents) {
  console.log(
    [
      String(a.score).padStart(5),
      a.status.padStart(10),
      fmt.bipsPct(a.feeBIPS).padStart(6),
      String(a.freeLots).padStart(6),
      fmt.bipsPct(a.vaultCollateralRatioBIPS).padStart(8),
      fmt.pct(a.vaultBuffer).padStart(7),
      fmt.bipsPct(a.poolCollateralRatioBIPS).padStart(8),
      fmt.pct(a.poolBuffer).padStart(7),
      fmt.pct(a.backingSurplus).padStart(12),
      a.address,
    ].join(' ')
  );
  for (const w of a.warnings) console.log(`${' '.repeat(6)}! ${w}`);
}

console.log(
  '\nbuffer  = headroom above the liquidation threshold (0% = at the line)\n' +
  'backing = surplus underlying XRP over what the agent owes redeemers\n' +
  '          negative means redemption pays collateral, not XRP'
);

const lots = Number(flag('--lots', 0));
if (lots > 0) {
  const best = bestAgentForLots(agents, lots);
  console.log(`\nMINT — you choose the agent. Best for ${lots} lot(s) (${lots * 10} XRP):`);
  if (!best) console.log('  none — no healthy agent has enough free lots');
  else {
    console.log(`  ${best.address}  score=${best.score}  fee=${fmt.bipsPct(best.feeBIPS)}  freeLots=${best.freeLots}`);
    console.log(`  underlying XRP address: ${best.underlyingAddress}`);
  }
}

const redeemLots = Number(flag('--redeem', 0));
if (redeemLots > 0) {
  const lotSize = await conn.assetManager.lotSize();
  const maxTickets = Number(await getSetting(conn, 'maxRedeemedTickets'));
  const queue = await loadRedemptionQueue(conn);
  const byAgent = Object.fromEntries(agents.map((a) => [a.address.toLowerCase(), a]));
  const p = previewRedemption(queue, byAgent, redeemLots, lotSize, maxTickets);

  console.log(`\nREDEEM — you do NOT choose. ${redeemLots} lot(s) = ${p.requestedXRP} XRP off a ${queue.length}-ticket queue:`);
  for (const f of p.fills) {
    const risk = f.underBacked ? '  <-- under-backed, this share likely pays collateral not XRP' : '';
    console.log(`  ${(f.share * 100).toFixed(1).padStart(5)}%  ${fmt.xrp(f.uba).padStart(10)} XRP  ${f.address}  backing=${f.backingSurplus === null ? '?' : fmt.pct(f.backingSurplus)}${risk}`);
  }
  if (p.shortfallXRP > 0) {
    console.log(p.cappedByTickets
      ? `  shortfall: ${p.shortfallXRP} XRP — hit the ${p.maxRedeemedTickets}-ticket cap per redemption; redeem again for the rest`
      : `  shortfall: ${p.shortfallXRP} XRP — queue is too shallow to fill this request`);
  }
  console.log(`  tickets consumed: ${p.ticketsUsed}/${p.maxRedeemedTickets} (protocol cap per transaction)`);
  console.log(`  at risk of collateral-instead-of-XRP: ${p.atRiskXRP} XRP (${fmt.pct(p.atRiskShare)})`);
}
