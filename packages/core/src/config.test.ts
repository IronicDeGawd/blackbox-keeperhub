import { describe, expect, it } from 'vitest';
import { CHAIN_IDS } from './chains.js';
import { blackboxConfigSchema, detectionFor, loadConfig } from './config.js';

const baseEnv = {
  KEEPERHUB_ORG_KEY: 'kh_test',
  DATABASE_URL: 'postgres://localhost/blackbox',
} satisfies NodeJS.ProcessEnv;

describe('dry run default', () => {
  it('defaults to true when the env says nothing', () => {
    expect(loadConfig(baseEnv).remediation.dryRun).toBe(true);
  });

  it('stays true for any value other than the exact string "false"', () => {
    for (const v of ['true', '0', 'no', 'FALSE', '']) {
      expect(loadConfig({ ...baseEnv, BLACKBOX_DRY_RUN: v }).remediation.dryRun).toBe(true);
    }
  });

  it('goes live only on the exact string "false"', () => {
    expect(loadConfig({ ...baseEnv, BLACKBOX_DRY_RUN: 'false' }).remediation.dryRun).toBe(false);
  });
});

describe('allowlists', () => {
  it('default to empty, so nothing is remediable until opted in', () => {
    const c = loadConfig(baseEnv);
    expect(c.remediation.signerAllowlist).toEqual([]);
    expect(c.remediation.chainAllowlist).toEqual([]);
  });

  it('parses comma-separated env values and drops empties', () => {
    const c = loadConfig({
      ...baseEnv,
      BLACKBOX_SIGNER_ALLOWLIST: '0xaaa,,0xbbb',
      BLACKBOX_CHAIN_ALLOWLIST: '11155111,,84532',
    });
    expect(c.remediation.signerAllowlist).toEqual(['0xaaa', '0xbbb']);
    expect(c.remediation.chainAllowlist).toEqual([11155111, 84532]);
  });
});

describe('detectionFor', () => {
  const config = blackboxConfigSchema.parse({
    keeperHub: { orgKey: 'kh_test' },
    databaseUrl: 'postgres://localhost/blackbox',
  });

  it('tightens the stuck threshold on 2s-block chains', () => {
    expect(detectionFor(config, CHAIN_IDS.baseSepolia).stuckThresholdMs).toBe(30_000);
    expect(detectionFor(config, CHAIN_IDS.sepolia).stuckThresholdMs).toBe(90_000);
  });

  it('keeps base values that the override does not mention', () => {
    const resolved = detectionFor(config, CHAIN_IDS.base);
    expect(resolved.stuckThresholdMs).toBe(30_000);
    expect(resolved.retryStormCount).toBe(config.detection.retryStormCount);
    expect(resolved.slippageToleranceBps).toBe(config.detection.slippageToleranceBps);
  });

  it('lets an explicit user override win over the per-chain default', () => {
    const withOverride = blackboxConfigSchema.parse({
      keeperHub: { orgKey: 'kh_test' },
      databaseUrl: 'postgres://localhost/blackbox',
      perChainDetection: { [CHAIN_IDS.baseSepolia]: { stuckThresholdMs: 5_000 } },
    });
    expect(detectionFor(withOverride, CHAIN_IDS.baseSepolia).stuckThresholdMs).toBe(5_000);
  });

  it('falls back to base values for a chain with no override', () => {
    expect(detectionFor(config, 42_161)).toEqual(config.detection);
  });
});

describe('replacement fee floor', () => {
  it('rejects a bump multiple below the 12.5% replacement rule', () => {
    expect(() =>
      blackboxConfigSchema.parse({
        keeperHub: { orgKey: 'kh_test' },
        databaseUrl: 'postgres://localhost/blackbox',
        remediation: { bumpMultiple: 1.1 },
      }),
    ).toThrow();
  });

  it('accepts a meaningful bump', () => {
    const c = blackboxConfigSchema.parse({
      keeperHub: { orgKey: 'kh_test' },
      databaseUrl: 'postgres://localhost/blackbox',
      remediation: { bumpMultiple: 1.3 },
    });
    expect(c.remediation.bumpMultiple).toBe(1.3);
  });
});
