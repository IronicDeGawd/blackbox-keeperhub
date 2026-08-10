import { createPublicClient, http, type PublicClient } from 'viem';
import {
  detectionFor,
  getChain,
  type BlackboxConfig,
  type Incident,
} from '@blackbox/core';
import { evaluateRules, findNonceGap, IncidentTracker } from '@blackbox/detector';
import { Diagnostician, VertexGemini } from '@blackbox/diagnostician';
import {
  BlockScanner,
  buildEventFromChain,
  Recorder,
  RpcCorroborator,
  type ChainReader,
} from '@blackbox/recorder';
import {
  getIncident,
  listIncidents,
  saveIncident,
  stats,
  watchTransaction,
  type Database,
} from '@blackbox/store';
import { KeeperHubClient } from '@blackbox/core';
import type { EventBus } from './bus.js';
import { incidentSummary, type IncidentRow } from './serialise.js';

/**
 * The long-running half of the server.
 *
 * The API answers questions; this is what makes there be anything to answer.
 * Each tick discovers transactions for watched addresses, ingests them,
 * evaluates the rules, and explains whatever is new — publishing every change
 * so the console's stream is a view of work actually happening rather than a
 * poll dressed up as one.
 *
 * Nothing here throws. A recorder that dies on one bad transaction stops
 * observing everything, which is a far worse failure than skipping one and
 * counting it.
 */

export type RuntimeOptions = {
  db: Database;
  config: BlackboxConfig;
  bus: EventBus;
  chainId: number;
  rpcUrl: string;
  /** Absent means incidents are detected but never explained. */
  diagnostician?: Diagnostician;
  /**
   * KeeperHub, when the process has a key for it.
   *
   * With it, executions submitted through KeeperHub are polled and normalised
   * alongside chain observations, which is the audit trail Blackbox was built
   * to read. Without it the recorder still works — it just sees only what the
   * chain shows, and every KeeperHub-specific field is simply absent.
   */
  keeperHub?: KeeperHubClient;
  /**
   * Extra endpoints to consult when looking up a transaction someone else's
   * wallet broadcast.
   *
   * A transaction above an unused nonce is *queued*, not pending, and a node
   * does not gossip queued transactions to its peers — they are not yet
   * executable, so there is nothing to propagate. It therefore exists only on
   * whichever endpoint the sender's wallet happened to use. Asking one node
   * finds a stranger's nonce gap only by luck; asking every endpoint we have
   * turns luck into reasonable odds.
   */
  fallbackRpcUrls?: string[];
  /** How many times to sweep those endpoints before giving up on a hash. */
  lookupRounds?: number;
  intervalMs?: number;
  logger?: { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
};

export function makeChainReader(clients: Record<number, PublicClient>): ChainReader {
  return {
    getTransaction: async ({ hash, chainId }) => {
      try {
        const tx = await clients[chainId]?.getTransaction({ hash });
        if (!tx) return null;
        // Mapped field by field rather than passed through: viem's type is far
        // wider, and a structural match today would break on any of its shape
        // changes tomorrow.
        return {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          input: tx.input,
          nonce: tx.nonce,
          ...(tx.maxFeePerGas !== undefined && tx.maxFeePerGas !== null
            ? { maxFeePerGas: tx.maxFeePerGas }
            : {}),
          ...(tx.maxPriorityFeePerGas !== undefined && tx.maxPriorityFeePerGas !== null
            ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas }
            : {}),
          ...(tx.gasPrice !== undefined && tx.gasPrice !== null ? { gasPrice: tx.gasPrice } : {}),
          blockNumber: tx.blockNumber ?? null,
        };
      } catch {
        // Not yet visible to this node, or dropped. The next poll decides.
        return null;
      }
    },
    getReceipt: async ({ hash, chainId }) => {
      try {
        return (await clients[chainId]?.getTransactionReceipt({ hash })) ?? null;
      } catch {
        return null;
      }
    },
    call: async ({ chainId, from, to, data, blockNumber }) => {
      try {
        await clients[chainId]?.call({ account: from, to, data, blockNumber });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          revertReason: String((error as Error).message).split('\n')[0]?.slice(0, 200) ?? '',
        };
      }
    },
  };
}

/**
 * Ask each endpoint in turn, and take the first that knows.
 *
 * Not redundancy for its own sake. A queued transaction — one sitting above an
 * unused nonce — is never gossiped between nodes, because it is not yet
 * executable, so it exists only in the mempool of the single machine its
 * sender talked to. Even one public endpoint is a fleet behind a load
 * balancer, so "does this transaction exist" is a question with a different
 * answer per request. One reader answers it wrongly and confidently.
 */
export function makeFallbackReader(readers: ChainReader[]): ChainReader {
  const first = readers[0]!;
  return {
    getTransaction: async (params) => {
      for (const reader of readers) {
        const tx = await reader.getTransaction(params);
        if (tx) return tx;
      }
      return null;
    },
    getReceipt: async (params) => {
      for (const reader of readers) {
        const receipt = await reader.getReceipt(params);
        if (receipt) return receipt;
      }
      return null;
    },
    // A simulation is a question about state, not about a mempool, so every
    // endpoint gives the same answer and there is nothing to fall back to.
    ...(first.call ? { call: first.call } : {}),
  };
}

export class Runtime {
  private readonly client: PublicClient;
  private readonly reader: ChainReader;
  /** The primary first, then any fallback, for finding a queued transaction. */
  private readonly lookupReaders: ChainReader[];
  private readonly recorder: Recorder;
  private readonly scanner: BlockScanner;
  private readonly tracker: IncidentTracker;
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;
  /** Incidents already explained, so a tick does not re-spend on diagnosis. */
  private readonly diagnosed = new Set<string>();

  constructor(private readonly options: RuntimeOptions) {
    this.client = createPublicClient({ transport: http(options.rpcUrl) }) as PublicClient;
    this.lookupReaders = [
      makeChainReader({ [options.chainId]: this.client }),
      ...(options.fallbackRpcUrls ?? [])
        .filter((url) => url && url !== options.rpcUrl)
        .map((url) =>
          makeChainReader({
            [options.chainId]: createPublicClient({ transport: http(url) }) as PublicClient,
          }),
        ),
    ];
    // The recorder reads through the same fallback, so a transaction only one
    // endpoint can see is still ingested on an ordinary tick.
    this.reader = makeFallbackReader(this.lookupReaders);
    this.tracker = new IncidentTracker({ makeId: () => this.id('inc') });

    this.recorder = new Recorder({
      db: options.db,
      keeperHub: options.keeperHub ?? {
        getExecutionStatus: async () => {
          // Only reached if something registered an execution while no key was
          // configured. Saying so beats a silent empty result.
          throw new Error(
            'A KeeperHub execution is registered but this process has no KeeperHub key. ' +
              'Set KEEPERHUB_ORG_KEY to poll it.',
          );
        },
      },
      corroboration: new RpcCorroborator({ rpcUrls: { [options.chainId]: options.rpcUrl } }),
      chain: this.reader,
      config: options.config,
      tracker: this.tracker,
      makeId: () => this.id('evt'),
      logger: options.logger ?? { info: () => {}, error: () => {} },
    });

    this.scanner = new BlockScanner({
      db: options.db,
      chainId: options.chainId,
      reader: {
        getBlockNumber: async () => this.client.getBlockNumber(),
        getBlockWithTransactions: async (_chainId, blockNumber) => {
          const block = await this.client.getBlock({ blockNumber, includeTransactions: true });
          return {
            transactions: block.transactions.map((t) => ({ hash: t.hash, from: t.from, to: t.to })),
          };
        },
      },
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }

  private id(prefix: string): string {
    return `${prefix}-${Date.now()}-${this.seq++}`;
  }

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? 15_000;
    // `unref` so the process can exit on a signal without waiting for a tick.
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    const { db, bus, logger } = this.options;
    try {
      const before = new Set((await listIncidents(db, { limit: 200 })).map((i) => i.id));

      const scan = await this.scanner.tick();
      if (scan.matched > 0 || scan.blocksScanned > 0) {
        bus.publish({ type: 'scan.progress', data: scan });
      }
      await this.recorder.tick();

      const after = await listIncidents(db, { limit: 200 });
      for (const row of after) {
        const summary = incidentSummary(row as IncidentRow);
        bus.publish({
          type: before.has(row.id) ? 'incident.updated' : 'incident.created',
          data: summary,
        });
      }

      await this.explainNew(after);
      // Carries the figures, not a nudge to refetch: the console's header
      // strip is driven by this event, and an empty payload leaves it stale.
      const summary = await stats(db);
      bus.publish({
        type: 'stats.updated',
        data: { ...summary, updatedAt: summary.updatedAt.toISOString() },
      });
    } catch (error) {
      logger?.error('runtime tick failed', { error });
    }
  }

  /**
   * Explain incidents that have no analysis yet.
   *
   * Bounded per tick: diagnosis costs a model call, and a burst of incidents
   * should not turn into a burst of inference the rate limiter will refuse
   * anyway. Anything skipped is picked up next tick.
   */
  private async explainNew(rows: Awaited<ReturnType<typeof listIncidents>>): Promise<void> {
    const { diagnostician, db, bus } = this.options;
    if (!diagnostician) return;

    const pending = rows.filter((row) => !row.rca && !this.diagnosed.has(row.id)).slice(0, 3);
    for (const row of pending) {
      this.diagnosed.add(row.id);
      try {
        const { rca } = await diagnostician.diagnose(rowToIncident(row));
        await saveIncident(db, { ...row, rca });
        bus.publish({
          type: 'incident.updated',
          data: incidentSummary({ ...row, rca } as IncidentRow),
        });
      } catch (error) {
        // The diagnostician is built never to throw; if it somehow does, the
        // incident keeps its evidence and simply has no narrative.
        this.options.logger?.error('diagnosis failed', { incidentId: row.id, error });
      }
    }
  }

  /**
   * Explain a single transaction for someone who has registered nothing.
   *
   * The whole pipeline, on demand, against one hash: fetch it, replay it
   * against the parent block if it reverted, run every rule, and explain
   * whatever fired. A clean transaction returns `class: null` with the facts
   * that were checked, because "nothing is wrong, and here is what I looked at"
   * is a useful answer rather than an empty one.
   */
  async diagnoseTransaction(params: { txHash: string; chainId: number }): Promise<unknown> {
    const chainId = params.chainId;
    const chain = getChain(chainId);
    const txHash = params.txHash as `0x${string}`;

    const tx = await this.reader.getTransaction({ hash: txHash, chainId });
    if (!tx) {
      return {
        txHash,
        chainId,
        found: false,
        detail: 'No such transaction on this chain, or it is not yet visible to this node.',
      };
    }

    const now = new Date();
    const { event } = await buildEventFromChain(this.reader, {
      txHash,
      agentId: 'ad-hoc',
      signer: tx.from,
      chainId,
      registeredAt: now,
      now,
      makeId: () => this.id('adhoc'),
    });
    if (!event) {
      return { txHash, chainId, found: false, detail: 'Transaction could not be read.' };
    }

    const [latestNonce, pendingNonce, balance, block] = await Promise.all([
      this.client.getTransactionCount({ address: tx.from, blockTag: 'latest' }),
      this.client.getTransactionCount({ address: tx.from, blockTag: 'pending' }),
      this.client.getBalance({ address: tx.from }),
      this.client.getBlock({ blockTag: 'latest' }),
    ]);

    const drafts = evaluateRules([event], {
      now,
      detection: detectionFor(this.options.config, chainId),
      agentId: 'ad-hoc',
      signer: tx.from,
      chainId,
      corroboration: {
        latestNonce,
        pendingNonce,
        signerBalance: balance,
        ...(block.baseFeePerGas !== null ? { baseFeeAtDetection: block.baseFeePerGas } : {}),
      },
    });

    const observed = {
      txHash,
      chainId,
      chain: chain.name,
      found: true,
      signer: tx.from,
      nonce: event.submission.nonce ?? null,
      status: event.outcome.status,
      blockNumber: event.outcome.blockNumber ?? null,
      simulation: {
        performed: event.simulation.performed,
        success: event.simulation.success ?? null,
        simulatedAtBlock: event.simulation.simulatedAtBlock ?? null,
        note: event.simulation.performed
          ? 'Replayed against the block before inclusion to establish whether state drifted.'
          : 'Not replayed: only a reverted transaction is worth replaying.',
      },
      explorerUrl: chain.explorerTxUrl(txHash),
    };

    const draft = drafts[0];
    if (!draft) {
      const gap = findNonceGap([event], latestNonce);
      return {
        ...observed,
        class: null,
        detail: 'No rule fired for this transaction.',
        checked: {
          latestNonce,
          pendingNonce,
          missingNonces: gap.missingNonces,
          balanceWei: balance.toString(),
        },
      };
    }

    const incident: Incident = {
      id: `adhoc-${txHash.slice(0, 10)}`,
      class: draft.class,
      severity: draft.severity,
      status: 'open',
      agentId: 'ad-hoc',
      signer: tx.from,
      chainId,
      detectedAt: now,
      firstEventAt: event.submission.submittedAt,
      confidence: draft.confidence,
      evidence: {
        eventIds: draft.eventIds,
        ruleId: draft.ruleId,
        facts: draft.facts,
        corroboration: {
          latestNonce,
          pendingNonce,
          signerBalance: balance,
          ...(block.baseFeePerGas !== null ? { baseFeeAtDetection: block.baseFeePerGas } : {}),
        },
      },
    };

    const diagnosis = await this.options.diagnostician?.diagnose(incident);
    return {
      ...observed,
      class: draft.class,
      severity: draft.severity,
      confidence: draft.confidence,
      ruleId: draft.ruleId,
      facts: draft.facts,
      ...(diagnosis
        ? { rca: diagnosis.rca, rcaSource: diagnosis.source }
        : { rca: null, rcaSource: 'none' }),
    };
  }

  /** Current market rates, for planning a replacement that will actually displace. */
  async market(): Promise<{ baseFee: bigint; suggestedPriorityFee: bigint }> {
    const block = await this.client.getBlock({ blockTag: 'latest' });
    return {
      baseFee: block.baseFeePerGas ?? 1_000_000_000n,
      suggestedPriorityFee: 1_000_000_000n,
    };
  }

  async getSubmittedTransaction(
    hash: `0x${string}`,
  ): Promise<{ from: string; to: string | null; nonce: number } | null> {
    try {
      const tx = await this.client.getTransaction({ hash });
      return { from: tx.from, to: tx.to ?? null, nonce: tx.nonce };
    } catch {
      return null;
    }
  }

  /** Wait for inclusion, bounded — a wallet may be slow, but not unbounded. */
  async waitForReceipt(
    hash: `0x${string}`,
    timeoutMs = 90_000,
  ): Promise<{ included: boolean; gasUsed?: bigint }> {
    try {
      const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
      return { included: receipt.status === 'success', gasUsed: receipt.gasUsed };
    } catch {
      return { included: false };
    }
  }

  nextId(prefix: string): string {
    return this.id(prefix);
  }

  /**
   * Tell the tracker what a remediation did, so the incident resolves as
   * Blackbox's work rather than as something that happened to get better.
   */
  attachRemediation(incidentId: string, record: Incident['remediation']): boolean {
    return this.tracker.attachRemediation(incidentId, record);
  }

  async signerHealth(params: { signer: string; chainId: number }): Promise<{
    balanceWei: string;
    latestNonce: number;
    pendingNonce: number;
    missingNonces: number[];
    runwayActions: number | null;
  }> {
    const address = params.signer as `0x${string}`;
    const [balance, latestNonce, pendingNonce] = await Promise.all([
      this.client.getBalance({ address }),
      this.client.getTransactionCount({ address, blockTag: 'latest' }),
      this.client.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    return {
      balanceWei: balance.toString(),
      latestNonce,
      pendingNonce,
      // Derived from observed submissions, since a queued transaction does not
      // raise the pending count.
      missingNonces: [],
      runwayActions: null,
    };
  }

  /**
   * Take delivery of transactions somebody else's wallet sent.
   *
   * Needed because block scanning cannot see the most interesting failure at
   * all: a transaction above an unused nonce is queued, never mined, and so
   * never appears in any block. Only the wallet that sent it knows it exists.
   *
   * The hash is taken as a pointer, not as testimony. Who sent it, at what
   * nonce and at what price are read from the chain, so a caller reporting
   * someone else's hash attributes it to that someone else and gains nothing.
   */
  async observeSubmissions(params: {
    txHashes: string[];
    chainId: number;
    /** Shared across a batch so retries of one action group together for R5. */
    runId?: string;
  }): Promise<{
    observed: { txHash: string; signer: string; nonce: number }[];
    ignored: { txHash: string; reason: string }[];
  }> {
    const observed: { txHash: string; signer: string; nonce: number }[] = [];
    const ignored: { txHash: string; reason: string }[] = [];

    for (const raw of params.txHashes) {
      const txHash = String(raw);
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        ignored.push({ txHash, reason: 'not a transaction hash' });
        continue;
      }
      // Safe by the regex just above, which is the only reason this narrows.
      const hash = txHash as `0x${string}`;
      // Rounds, not one pass. A public endpoint is a fleet behind a load
      // balancer, and a queued transaction lives in the mempool of exactly one
      // machine in it — measured at roughly two misses for every hit on
      // Sepolia. Asking again lands on a different backend.
      let tx = null;
      const rounds = this.options.lookupRounds ?? 4;
      for (let round = 0; round < rounds && !tx; round++) {
        for (const reader of this.lookupReaders) {
          tx = await reader.getTransaction({ hash, chainId: params.chainId });
          if (tx) break;
        }
        if (!tx && round < rounds - 1) await new Promise((r) => setTimeout(r, 250));
      }
      if (!tx) {
        // Every endpoint we have denies knowing it. Most likely it was queued
        // behind a nonce gap on a node we cannot reach, since those are never
        // gossiped. Attributing it anyway would mean taking the caller's word
        // for who signed it, which is exactly what this refuses to do.
        ignored.push({
          txHash,
          reason:
            'no endpoint we can reach has this transaction; if it is queued behind a nonce ' +
            'gap it exists only on the node your wallet broadcast to',
        });
        continue;
      }
      await watchTransaction(this.options.db, {
        txHash,
        signer: tx.from,
        agentId: tx.from.slice(0, 10),
        chainId: params.chainId,
        label: 'self-signed chaos',
        at: new Date(),
        ...(params.runId ? { logicalActionId: params.runId } : {}),
      });
      observed.push({ txHash, signer: tx.from, nonce: tx.nonce });
    }
    return { observed, ignored };
  }

  /**
   * What a wallet needs to sign chaos for itself.
   *
   * Read live rather than assumed: the nonce decides where the gap goes, and
   * the base fee decides what "underpriced" means on this chain right now.
   * A stale value for either produces a transaction that either fails to
   * broadcast or induces nothing.
   */
  async chaosChainState(signer: string): Promise<{ nextNonce: number; baseFeePerGas: bigint }> {
    const [nextNonce, block] = await Promise.all([
      // Pending, not latest: their wallet will sign the next one it would use,
      // so the gap has to be measured from there or there is no gap at all.
      this.client.getTransactionCount({ address: signer as `0x${string}`, blockTag: 'pending' }),
      this.client.getBlock({ blockTag: 'latest' }),
    ]);
    // A pre-1559 chain reports no base fee; the fallback keeps the plan
    // signable rather than pricing everything at zero.
    return { nextNonce, baseFeePerGas: block.baseFeePerGas ?? 1_000_000_000n };
  }
}

function rowToIncident(row: Awaited<ReturnType<typeof listIncidents>>[number]): Incident {
  return {
    id: row.id,
    class: row.class,
    severity: row.severity,
    status: row.status,
    agentId: row.agentId,
    signer: row.signer,
    chainId: row.chainId,
    detectedAt: row.detectedAt,
    firstEventAt: row.firstEventAt,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
    confidence: row.confidence,
    evidence: row.evidence,
  } as Incident;
}

/** Build a KeeperHub client from env, or nothing if no key is configured. */
export function keeperHubFromEnv(
  env: Record<string, string | undefined>,
): KeeperHubClient | undefined {
  const orgKey = env['KEEPERHUB_ORG_KEY'];
  // The webhook (`wfb_`) key 200s on reads and 401s on every execution, so a
  // key of the wrong type is worse than none: it looks configured and is not.
  if (!orgKey || !orgKey.startsWith('kh_')) return undefined;
  return new KeeperHubClient({ orgKey });
}

/** Build a diagnostician from env, or nothing if no project is configured. */
export function diagnosticianFromEnv(env: Record<string, string | undefined>): Diagnostician | undefined {
  const projectId = env['GOOGLE_CLOUD_PROJECT'];
  if (!projectId) return undefined;
  return new Diagnostician({
    llm: new VertexGemini({
      projectId,
      ...(env['GEMINI_MODEL'] ? { model: env['GEMINI_MODEL'] } : {}),
    }),
  });
}

export { getIncident };
