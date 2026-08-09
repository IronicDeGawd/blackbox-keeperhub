import { describe, expect, it } from 'vitest';
import {
  CHAIN_IDS,
  CHAOS_ALLOWED_CHAINS,
  CHAINS,
  assertChaosAllowed,
  getChain,
  isSupportedChain,
} from './chains.js';

describe('chaos chain safety', () => {
  it('permits the two testnets', () => {
    expect(() => assertChaosAllowed(CHAIN_IDS.sepolia)).not.toThrow();
    expect(() => assertChaosAllowed(CHAIN_IDS.baseSepolia)).not.toThrow();
  });

  it('refuses both mainnets', () => {
    expect(() => assertChaosAllowed(CHAIN_IDS.ethereum)).toThrow(/refused/);
    expect(() => assertChaosAllowed(CHAIN_IDS.base)).toThrow(/refused/);
  });

  it('refuses an unknown chain', () => {
    expect(() => assertChaosAllowed(999_999)).toThrow(/refused/);
  });

  it('never lists a non-testnet as a chaos target', () => {
    for (const chainId of CHAOS_ALLOWED_CHAINS) {
      expect(CHAINS[chainId].isTestnet).toBe(true);
    }
  });
});

describe('private mempool availability', () => {
  // Mirrors KeeperHub's per-chain usePrivateMempoolRpc, probed 2026-08-09.
  // P3 is unavailable wherever this is false; a regression here would make the
  // remediator attempt a reroute that cannot exist.
  it('matches the values KeeperHub reports', () => {
    expect(CHAINS[CHAIN_IDS.ethereum].privateMempool).toBe(true);
    expect(CHAINS[CHAIN_IDS.sepolia].privateMempool).toBe(true);
    expect(CHAINS[CHAIN_IDS.base].privateMempool).toBe(false);
    expect(CHAINS[CHAIN_IDS.baseSepolia].privateMempool).toBe(false);
  });

  it('covers both a private-capable and a public-only testnet', () => {
    const testnets = CHAOS_ALLOWED_CHAINS.map((id) => CHAINS[id]);
    expect(testnets.some((c) => c.privateMempool)).toBe(true);
    expect(testnets.some((c) => !c.privateMempool)).toBe(true);
  });
});

describe('chain lookup', () => {
  it('narrows supported ids', () => {
    expect(isSupportedChain(CHAIN_IDS.base)).toBe(true);
    expect(isSupportedChain(42_161)).toBe(false);
  });

  it('throws on an unsupported id rather than returning undefined', () => {
    expect(() => getChain(42_161)).toThrow(/Unsupported chain/);
  });

  it('builds explorer links per chain', () => {
    const hash = `0x${'a'.repeat(64)}`;
    expect(getChain(CHAIN_IDS.sepolia).explorerTxUrl(hash)).toBe(
      `https://sepolia.etherscan.io/tx/${hash}`,
    );
    expect(getChain(CHAIN_IDS.baseSepolia).explorerTxUrl(hash)).toBe(
      `https://sepolia.basescan.org/tx/${hash}`,
    );
  });
});
