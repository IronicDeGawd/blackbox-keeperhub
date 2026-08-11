import { KeeperHubClient, type KeeperHubRun, type SupportedChainId } from '@blackbox/core';
import { KeeperHubSource, type KeeperHubIngestResult } from '@blackbox/recorder';
import {
  listSweepableConnections,
  listWatchedWorkflows,
  recordConnectionSweep,
  recordWorkflowRun,
  type Database,
} from '@blackbox/store';
import type { Connections } from './connections.js';

/**
 * Read the runs of every account that connected, plus this deployment's own.
 *
 * Before this, ingestion swept exactly one organisation — the one named in the
 * environment — so signing in gave an operator identity and ownership while
 * Blackbox read none of their runs. That gap is what this closes: a connection
 * is a thing that gets swept, and the workflows the operator picked are what it
 * sweeps.
 *
 * The deployment's own organisation stays a source of its own, so the demo goes
 * on working with nobody connected.
 */

export type ConnectionSweeperOptions = {
  db: Database;
  connections: Connections;
  /** Applied to a run that names no network, as for the env-based source. */
  fallbackChainId?: SupportedChainId;
  keeperHubApiUrl?: string;
  /** Injected transport for reads on a connection's behalf; tests use it. */
  keeperHubFetch?: typeof fetch;
  range?: string;
  makeId: () => string;
  now?: () => Date;
  logger?: { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
  /** The deployment's own organisation, if it has one. Swept first. */
  ownSource?: { ingest(): Promise<KeeperHubIngestResult> };
};

const empty = (): KeeperHubIngestResult => ({
  runsSeen: 0,
  runsIngested: 0,
  eventsInserted: 0,
  pagesFetched: 0,
  truncated: false,
  skippedUnknownChain: 0,
  runsFiltered: 0,
  touched: [],
  errors: 0,
});

const merge = (into: KeeperHubIngestResult, from: KeeperHubIngestResult): KeeperHubIngestResult => ({
  runsSeen: into.runsSeen + from.runsSeen,
  runsIngested: into.runsIngested + from.runsIngested,
  eventsInserted: into.eventsInserted + from.eventsInserted,
  pagesFetched: into.pagesFetched + from.pagesFetched,
  truncated: into.truncated || from.truncated,
  skippedUnknownChain: into.skippedUnknownChain + from.skippedUnknownChain,
  runsFiltered: into.runsFiltered + from.runsFiltered,
  touched: [...into.touched, ...from.touched],
  errors: into.errors + from.errors,
});

/**
 * One workflow, one agent.
 *
 * `agentId` is Blackbox's own label, not a KeeperHub entity, and it used to be
 * a single bucket for a whole organisation. That averaged every workflow's
 * health into one row and gave `EXECUTION_STALLED` a window spanning everything
 * the organisation runs. A workflow is the thing an operator actually thinks
 * about, so it is the thing incidents belong to.
 */
export function agentIdForRun(orgId: string, run: KeeperHubRun): string {
  return run.workflowId ? `kh:${run.workflowId}` : `kh:direct:${orgId}`;
}

export class ConnectionSweeper {
  private readonly now: () => Date;

  constructor(private readonly options: ConnectionSweeperOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async ingest(): Promise<KeeperHubIngestResult> {
    let result = empty();

    if (this.options.ownSource) {
      try {
        result = merge(result, await this.options.ownSource.ingest());
      } catch (error) {
        result.errors += 1;
        this.options.logger?.error('own-organisation sweep failed', { error });
      }
    }

    // Connections whose chosen lifetime has run out stop being swept here, and
    // their owners are told, rather than the sweep quietly reading nothing.
    await this.options.connections.expireDue();

    for (const connection of await listSweepableConnections(this.options.db, this.now())) {
      try {
        result = merge(result, await this.sweepOne(connection.orgId));
      } catch (error) {
        result.errors += 1;
        this.options.logger?.error('connection sweep failed', { orgId: connection.orgId, error });
      }
    }

    return result;
  }

  private async sweepOne(orgId: string): Promise<KeeperHubIngestResult> {
    const watched = await listWatchedWorkflows(this.options.db, orgId, { activeOnly: true });
    // An operator who connected and picked nothing has said nothing is
    // important yet. Reading their whole history anyway would be watching more
    // than they asked for.
    if (watched.length === 0) return empty();

    const signer = await this.options.connections.signerFor(orgId);
    if (!signer) {
      // Without the address the organisation executes as there is nothing to
      // file its runs against, and guessing one would put its activity under a
      // stranger. Waiting is the honest option.
      this.options.logger?.info('connection has no signer yet; skipping its sweep', { orgId });
      return empty();
    }

    const source = new KeeperHubSource({
      db: this.options.db,
      client: {
        listRuns: async (params) => {
          const token = await this.options.connections.accessTokenFor(orgId);
          if (!token.ok) throw new Error(`${orgId}: ${token.detail}`);
          return new KeeperHubClient({
            accessToken: token.accessToken,
            ...(this.options.keeperHubApiUrl ? { baseUrl: this.options.keeperHubApiUrl } : {}),
            ...(this.options.keeperHubFetch ? { fetchImpl: this.options.keeperHubFetch } : {}),
          }).listRuns(params);
        },
      },
      orgId,
      agentId: (run) => agentIdForRun(orgId, run),
      workflowIds: watched.map((w) => w.workflowId),
      signer,
      ...(this.options.fallbackChainId !== undefined
        ? { fallbackChainId: this.options.fallbackChainId }
        : {}),
      ...(this.options.range ? { range: this.options.range } : {}),
      makeId: this.options.makeId,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
    });

    const result = await source.ingest();
    const at = this.now();
    await recordConnectionSweep(this.options.db, orgId, at);
    // Keeps the console's "last seen" honest per workflow rather than per org.
    for (const target of result.touched) {
      const workflowId = target.agentId.startsWith('kh:') ? target.agentId.slice(3) : null;
      if (workflowId && !workflowId.startsWith('direct:')) {
        await recordWorkflowRun(this.options.db, { orgId, workflowId, at });
      }
    }
    return result;
  }
}
