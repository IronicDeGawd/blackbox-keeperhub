import { readFileSync } from 'node:fs';
import { blackboxConfigSchema } from '@blackbox/core';
import { createDb } from '@blackbox/store';
import { buildApp } from './app.js';
import { EventBus } from './bus.js';
import { diagnosticianFromEnv, Runtime } from './runtime.js';

/**
 * Composition root.
 *
 * Reads `.env.local` if present so a developer needs no shell setup, then falls
 * back to the process environment for a deployed run.
 */
function loadEnv(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env };
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      if (!line.includes('=') || line.trim().startsWith('#')) continue;
      const i = line.indexOf('=');
      const key = line.slice(0, i).trim();
      if (merged[key] === undefined) merged[key] = line.slice(i + 1).trim();
    }
  } catch {
    // No file is a normal deployment; the environment carries everything.
  }
  return merged;
}

const env = loadEnv();
const chainId = Number(env['CHAIN_ID'] ?? 11155111);
const rpcUrl = env['ALCHEMY_RPC_URL'] ?? env['SEPOLIA_RPC_URL'];
if (!rpcUrl) throw new Error('No RPC URL: set ALCHEMY_RPC_URL or SEPOLIA_RPC_URL');

const databaseUrl = env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const config = blackboxConfigSchema.parse({
  keeperHub: { orgKey: env['KEEPERHUB_ORG_KEY'] ?? 'kh_unset' },
  databaseUrl,
  remediation: {
    // Live remediation stays an explicit opt-in, even here.
    dryRun: env['BLACKBOX_DRY_RUN'] !== 'false',
    ...(env['CHAOS_SIGNER_ADDRESS'] ? { signerAllowlist: [env['CHAOS_SIGNER_ADDRESS']] } : {}),
    chainAllowlist: [chainId],
  },
});

const { db, close } = createDb(databaseUrl);
const bus = new EventBus();
const logger = {
  info: (m: string, d?: unknown) => console.log('[info]', m, d ?? ''),
  error: (m: string, d?: unknown) => console.error('[error]', m, d ?? ''),
};

const diagnostician = diagnosticianFromEnv(env);
const runtime = new Runtime({
  db,
  config,
  bus,
  chainId,
  rpcUrl,
  ...(diagnostician ? { diagnostician } : {}),
  ...(env['BLACKBOX_TICK_MS'] ? { intervalMs: Number(env['BLACKBOX_TICK_MS']) } : {}),
  logger,
});

const app = await buildApp({
  db,
  config,
  bus,
  diagnose: (params) => runtime.diagnoseTransaction(params),
  signerHealth: (params) => runtime.signerHealth(params),
  logger: false,
});

const port = Number(env['PORT'] ?? 4000);
await app.listen({ port, host: '0.0.0.0' });
runtime.start();

console.log(`blackbox api on http://localhost:${port}`);
console.log(`  chain ${chainId} · diagnostician ${diagnostician ? 'on' : 'off'} · dryRun ${config.remediation.dryRun}`);
console.log('  POST /api/watched   { "signer": "0x..." }   watch any address');
console.log('  POST /api/diagnose  { "txHash": "0x..." }   explain any transaction');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      runtime.stop();
      await app.close();
      await close();
      process.exit(0);
    })();
  });
}
