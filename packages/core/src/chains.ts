/**
 * Chain registry.
 *
 * `privateMempool` is not a Blackbox preference — it mirrors KeeperHub's own
 * per-chain `usePrivateMempoolRpc` flag, read from `GET /api/chains` on
 * 2026-08-09 (raw response cached at context/research/keeperhub-chains.json).
 * Playbook P3 has nothing to reroute to on a chain where it is false, so the
 * remediator skips by policy rather than pretending to act.
 */

export const CHAIN_IDS = {
  ethereum: 1,
  sepolia: 11155111,
  base: 8453,
  baseSepolia: 84532,
} as const;

export type SupportedChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

export type ChainInfo = {
  readonly chainId: SupportedChainId;
  /** KeeperHub's `network` request parameter for this chain. */
  readonly keeperHubNetwork: string;
  readonly name: string;
  readonly isTestnet: boolean;
  readonly privateMempool: boolean;
  /** KeeperHub gas-limit safety multiplier, standard trigger. */
  readonly gasMultiplierStandard: number;
  /** Used for event/webhook triggers, where there is less room to retry. */
  readonly gasMultiplierConservative: number;
  readonly explorerTxUrl: (hash: string) => string;
};

export const CHAINS: Readonly<Record<SupportedChainId, ChainInfo>> = {
  [CHAIN_IDS.ethereum]: {
    chainId: CHAIN_IDS.ethereum,
    keeperHubNetwork: 'ethereum',
    name: 'Ethereum Mainnet',
    isTestnet: false,
    privateMempool: true,
    gasMultiplierStandard: 2.0,
    gasMultiplierConservative: 2.5,
    explorerTxUrl: (h) => `https://etherscan.io/tx/${h}`,
  },
  [CHAIN_IDS.sepolia]: {
    chainId: CHAIN_IDS.sepolia,
    keeperHubNetwork: 'sepolia',
    name: 'Ethereum Sepolia',
    isTestnet: true,
    privateMempool: true,
    gasMultiplierStandard: 2.0,
    gasMultiplierConservative: 2.5,
    explorerTxUrl: (h) => `https://sepolia.etherscan.io/tx/${h}`,
  },
  [CHAIN_IDS.base]: {
    chainId: CHAIN_IDS.base,
    keeperHubNetwork: 'base',
    name: 'Base',
    isTestnet: false,
    privateMempool: false,
    gasMultiplierStandard: 1.5,
    gasMultiplierConservative: 2.0,
    explorerTxUrl: (h) => `https://basescan.org/tx/${h}`,
  },
  [CHAIN_IDS.baseSepolia]: {
    chainId: CHAIN_IDS.baseSepolia,
    keeperHubNetwork: 'base-sepolia',
    name: 'Base Sepolia',
    isTestnet: true,
    privateMempool: false,
    gasMultiplierStandard: 1.5,
    gasMultiplierConservative: 2.0,
    explorerTxUrl: (h) => `https://sepolia.basescan.org/tx/${h}`,
  },
} as const;

export function isSupportedChain(chainId: number): chainId is SupportedChainId {
  return chainId in CHAINS;
}

export function getChain(chainId: number): ChainInfo {
  const chain = CHAINS[chainId as SupportedChainId];
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`);
  return chain;
}

/**
 * Chaos may only ever run against these. Compiled in, per PRD §8 — there is
 * deliberately no config key and no override flag that can widen this.
 */
export const CHAOS_ALLOWED_CHAINS: readonly SupportedChainId[] = [
  CHAIN_IDS.sepolia,
  CHAIN_IDS.baseSepolia,
] as const;

export function assertChaosAllowed(chainId: number): void {
  if (!CHAOS_ALLOWED_CHAINS.includes(chainId as SupportedChainId)) {
    throw new Error(
      `Chaos harness refused: chain ${chainId} is not a permitted chaos target. ` +
        `Permitted: ${CHAOS_ALLOWED_CHAINS.join(', ')}.`,
    );
  }
}
