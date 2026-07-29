#!/usr/bin/env node
/**
 * FXRP Agent Radar CLI.
 *
 *   node bin/radar.mjs              ranked agent table
 *   node bin/radar.mjs --lots 5     also pick the best agent for 5 lots
 *   node bin/radar.mjs --json       machine-readable output
 */
import { connect, scanAgents, bestAgentForLots, fmt } from '../src/radar.mjs';

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
  console.log(`\nBest agent for ${lots} lot(s) (${lots * 10} XRP):`);
  if (!best) console.log('  none — no healthy agent has enough free lots');
  else {
    console.log(`  ${best.address}  score=${best.score}  fee=${fmt.bipsPct(best.feeBIPS)}  freeLots=${best.freeLots}`);
    console.log(`  underlying XRP address: ${best.underlyingAddress}`);
  }
}
