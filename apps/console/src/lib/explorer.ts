import type { ChainConfig } from './types';

/**
 * Explorer links come from the chain registry's `explorerTxUrl` template, never
 * from a hardcoded host — the console renders incidents from more than one
 * chain at a time, and Base Sepolia is not Etherscan.
 *
 * The server also sends a ready-made `explorerUrl` on some shapes and the mock
 * does not; where it exists it wins, because it came from the same registry.
 */
export function explorerTxUrl(
  chains: ChainConfig[],
  chainId: number,
  hash: string | null | undefined,
  override?: string | null,
): string | null {
  if (override) return override;
  if (!hash) return null;

  const chain = chains.find((c) => c.chainId === chainId);
  if (!chain?.explorerTxUrl) return null;

  return chain.explorerTxUrl.replace('{hash}', hash);
}

/**
 * An address link, derived from the transaction template.
 *
 * The registry only publishes `explorerTxUrl`, and every explorer it names uses
 * the sibling `/address/` path. Derived rather than hardcoded per chain, and it
 * returns null instead of guessing when the template is not that shape.
 */
export function explorerAddressUrl(
  chains: ChainConfig[],
  chainId: number,
  address: string | null | undefined,
): string | null {
  if (!address) return null;

  const template = chains.find((c) => c.chainId === chainId)?.explorerTxUrl;
  if (!template?.includes('/tx/')) return null;

  return template.replace('/tx/', '/address/').replace('{hash}', address);
}

export function chainOf(chains: ChainConfig[], chainId: number): ChainConfig | null {
  return chains.find((c) => c.chainId === chainId) ?? null;
}

/** The chain's name, falling back to the id so an unknown chain still reads. */
export function chainName(chains: ChainConfig[], chainId: number): string {
  return chainOf(chains, chainId)?.name ?? `chain ${chainId}`;
}

/**
 * Unknown chains are reported as not-a-testnet on purpose. The banner exists to
 * make real money unmistakable, so the safe default is the loud one.
 */
export function isTestnet(chains: ChainConfig[], chainId: number): boolean {
  return chainOf(chains, chainId)?.testnet ?? false;
}
