import { z } from 'zod';
import { CHAIN_IDS, type SupportedChainId } from './chains.js';

/**
 * Every threshold lives here. Rules must not hold magic numbers — tests vary
 * them, and the console renders them next to the evidence so a reader can see
 * exactly why a rule tripped.
 */

const detectionSchema = z.object({
  stuckThresholdMs: z.number().int().positive().default(90_000),
  nonceGapConfirmations: z.number().int().positive().default(2),
  underpriceRatio: z.number().positive().default(1.0),
  retryStormCount: z.number().int().min(2).default(4),
  retryStormWindowMs: z.number().int().positive().default(300_000),
  gasStarvedMultiple: z.number().positive().default(3),
  slippageToleranceBps: z.number().int().nonnegative().default(50),
});

export type DetectionConfig = z.infer<typeof detectionSchema>;

const remediationSchema = z.object({
  /** Defaults to true. Live remediation is an explicit opt-in. */
  dryRun: z.boolean().default(true),
  minConfidence: z.number().min(0).max(1).default(0.8),
  maxAttempts: z.number().int().min(1).default(2),
  bumpMultiple: z.number().min(1.125).default(1.3),
  verifyTimeoutMs: z.number().int().positive().default(120_000),
  signerAllowlist: z.array(z.string()).default([]),
  chainAllowlist: z.array(z.number().int()).default([]),
  budget: z
    .object({
      maxRemediationsPerHour: z.number().int().positive().default(10),
      maxGasWeiPerHour: z
        .union([z.string(), z.bigint()])
        .transform((v) => (typeof v === 'bigint' ? v : BigInt(v)))
        .default('50000000000000000'),
    })
    .default({}),
  topupActionsTarget: z.number().int().positive().default(10),
});

const chaosSchema = z.object({
  enabled: z.boolean().default(false),
  signer: z.string().optional(),
});

const llmSchema = z.object({
  model: z.string().default('anthropic/claude-sonnet-5'),
  temperature: z.number().min(0).max(2).default(0.1),
  promptVersion: z.string().default('v1'),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().default('https://openrouter.ai/api/v1'),
});

export const blackboxConfigSchema = z.object({
  detection: detectionSchema.default({}),
  /** Per-chain overrides layered over `detection`. Base's 2s blocks make the
   *  default 90s stuck threshold far too slack there. */
  perChainDetection: z
    .record(z.coerce.number(), detectionSchema.partial())
    .default({}),
  remediation: remediationSchema.default({}),
  chaos: chaosSchema.default({}),
  llm: llmSchema.default({}),
  keeperHub: z.object({
    baseUrl: z.string().url().default('https://app.keeperhub.com/api'),
    orgKey: z.string().min(1),
  }),
  rpcUrls: z.record(z.coerce.number(), z.string().url()).default({}),
  databaseUrl: z.string().min(1),
});

export type BlackboxConfig = z.infer<typeof blackboxConfigSchema>;

/** Defaults tuned per chain. Block time is the driver. */
export const DEFAULT_PER_CHAIN_DETECTION: Record<number, Partial<DetectionConfig>> = {
  // ~2s blocks: 90s of "pending" is already ~45 blocks. Tighten hard.
  [CHAIN_IDS.base]: { stuckThresholdMs: 30_000 },
  [CHAIN_IDS.baseSepolia]: { stuckThresholdMs: 30_000 },
  // ~12s blocks: the 90s default is ~7 blocks, which is reasonable.
  [CHAIN_IDS.ethereum]: { stuckThresholdMs: 90_000 },
  [CHAIN_IDS.sepolia]: { stuckThresholdMs: 90_000 },
};

/**
 * Resolve the thresholds a rule should use for a given chain.
 *
 * Overrides are applied key by key rather than by spreading: a partial
 * override carries `undefined` for every key it does not set, and spreading
 * those would blow away the base value under `exactOptionalPropertyTypes`.
 */
export function detectionFor(
  config: BlackboxConfig,
  chainId: SupportedChainId | number,
): DetectionConfig {
  const resolved: DetectionConfig = { ...config.detection };
  for (const override of [
    DEFAULT_PER_CHAIN_DETECTION[chainId],
    config.perChainDetection[chainId],
  ]) {
    if (!override) continue;
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined) {
        (resolved as Record<string, unknown>)[key] = value;
      }
    }
  }
  return resolved;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BlackboxConfig {
  const rpcUrls: Record<number, string> = {};
  if (env['SEPOLIA_RPC_URL']) rpcUrls[CHAIN_IDS.sepolia] = env['SEPOLIA_RPC_URL'];
  if (env['BASE_SEPOLIA_RPC_URL']) rpcUrls[CHAIN_IDS.baseSepolia] = env['BASE_SEPOLIA_RPC_URL'];
  if (env['MAINNET_RPC_URL']) rpcUrls[CHAIN_IDS.ethereum] = env['MAINNET_RPC_URL'];
  if (env['BASE_MAINNET_RPC_URL']) rpcUrls[CHAIN_IDS.base] = env['BASE_MAINNET_RPC_URL'];

  return blackboxConfigSchema.parse({
    keeperHub: { orgKey: env['KEEPERHUB_ORG_KEY'] ?? '' },
    databaseUrl: env['DATABASE_URL'] ?? '',
    rpcUrls,
    remediation: {
      dryRun: env['BLACKBOX_DRY_RUN'] !== 'false',
      signerAllowlist: env['BLACKBOX_SIGNER_ALLOWLIST']?.split(',').filter(Boolean) ?? [],
      chainAllowlist:
        env['BLACKBOX_CHAIN_ALLOWLIST']?.split(',').filter(Boolean).map(Number) ?? [],
    },
    chaos: {
      enabled: env['BLACKBOX_CHAOS_ENABLED'] === 'true',
      signer: env['CHAOS_SIGNER_ADDRESS'],
    },
    llm: { apiKey: env['OPENROUTER_API_KEY'] },
  });
}
