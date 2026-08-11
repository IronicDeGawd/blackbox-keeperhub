import {
  normaliseRun,
  type KeeperHubRun,
  type KeeperHubRunPage,
  type SupportedChainId,
} from '@blackbox/core';
import { getCursor, insertEvents, setCursor, type Database } from '@blackbox/store';

/**
 * Ingest an organisation's KeeperHub run history.
 *
 * The PRD calls the audit trail Blackbox's input, and this is the only way to
 * read it: `GET /api/analytics/runs` lists every run the organisation made,
 * including ones Blackbox never submitted and ones that produced no transaction
 * for any chain scan to find.
 *
 * The listing pages *backwards* — its cursor is the `startedAt` of the last run
 * returned, applied with a strict `<`. That is a good pager and a useless
 * resume token: it walks into the past, and a position in the past says nothing
 * about what has happened since. So the durable state here is a high-water
 * mark, and each sweep pages back from the newest run until it reaches it.
 */

export type RunLister = {
  listRuns(params: {
    cursor?: string;
    limit?: number;
    range?: string;
    source?: 'workflow' | 'direct';
  }): Promise<KeeperHubRunPage>;
};

export type KeeperHubSourceOptions = {
  db: Database;
  client: RunLister;
  /** Scopes the cursor. One organisation, one position. */
  orgId: string;
  /** Whose incidents these runs become in the console. */
  agentId: string;
  /** The address the organisation executes as; runs do not carry one. */
  signer: `0x${string}`;
  /** Applied to a run that names no network. Absent means such runs are skipped. */
  fallbackChainId?: SupportedChainId;
  /** How far back a sweep may look. Also bounds the very first sweep. */
  range?: string;
  pageSize?: number;
  /** Bounds one sweep. Hitting it is reported, never silently absorbed. */
  maxPages?: number;
  now?: () => Date;
  makeId: () => string;
  logger?: { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
};

export type KeeperHubIngestResult = {
  runsSeen: number;
  /** Runs that yielded at least one event. */
  runsIngested: number;
  eventsInserted: number;
  pagesFetched: number;
  /** True when `maxPages` stopped the sweep before it reached the high-water mark. */
  truncated: boolean;
  /** Runs skipped for naming no chain we can read receipts on. */
  skippedUnknownChain: number;
  /** Signers to evaluate rules for, in the shape the recorder's tick uses. */
  touched: { signer: `0x${string}`; chainId: number; agentId: string }[];
  errors: number;
};

const TERMINAL = new Set(['success', 'error', 'system_error', 'external_error', 'cancelled']);

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;

export class KeeperHubSource {
  private readonly now: () => Date;

  constructor(private readonly options: KeeperHubSourceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get cursorKey(): string {
    return `keeperhub:${this.options.orgId}`;
  }

  async ingest(): Promise<KeeperHubIngestResult> {
    const result: KeeperHubIngestResult = {
      runsSeen: 0,
      runsIngested: 0,
      eventsInserted: 0,
      pagesFetched: 0,
      truncated: false,
      skippedUnknownChain: 0,
      touched: [],
      errors: 0,
    };

    const highWater = await getCursor(this.options.db, this.cursorKey);
    const highWaterMs = highWater ? Date.parse(highWater) : Number.NEGATIVE_INFINITY;
    const maxPages = this.options.maxPages ?? DEFAULT_MAX_PAGES;

    const fresh: KeeperHubRun[] = [];
    let cursor: string | undefined;
    let reachedHighWater = false;

    for (let page = 0; page < maxPages; page += 1) {
      const listed = await this.options.client.listRuns({
        ...(cursor ? { cursor } : {}),
        limit: this.options.pageSize ?? DEFAULT_PAGE_SIZE,
        range: this.options.range ?? '7d',
      });
      result.pagesFetched += 1;
      result.runsSeen += listed.runs.length;

      for (const run of listed.runs) {
        // Strictly newer only. A run at exactly the mark was ingested last
        // sweep, and re-reading it costs a page for nothing.
        if (Date.parse(run.startedAt) > highWaterMs) fresh.push(run);
        else reachedHighWater = true;
      }

      if (reachedHighWater || !listed.nextCursor || listed.runs.length === 0) break;
      cursor = listed.nextCursor;
      if (page === maxPages - 1) result.truncated = true;
    }

    if (result.truncated) {
      // A sweep that stopped early leaves a gap that the next one cannot close,
      // because the mark only ever moves forward. Say so rather than let the
      // run count quietly under-report the org's activity.
      this.options.logger?.error('keeperhub sweep truncated before reaching the high-water mark', {
        orgId: this.options.orgId,
        pagesFetched: result.pagesFetched,
        runsSeen: result.runsSeen,
      });
    }

    const at = this.now();
    const touched = new Map<string, { signer: `0x${string}`; chainId: number; agentId: string }>();
    /** Runs the mark must not move past, because they were not stored. */
    const unstored = new Set<string>();

    // Oldest first, so a failure part-way through leaves the mark behind the
    // runs that were not stored rather than in front of them.
    for (const run of [...fresh].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      try {
        const events = normaliseRun(run, {
          agentId: this.options.agentId,
          signer: this.options.signer,
          now: at,
          makeId: this.options.makeId,
          ...(this.options.fallbackChainId !== undefined
            ? { fallbackChainId: this.options.fallbackChainId }
            : {}),
        });
        if (events.length === 0) {
          result.skippedUnknownChain += 1;
          continue;
        }
        result.eventsInserted += await insertEvents(this.options.db, events);
        result.runsIngested += 1;
        for (const event of events) {
          touched.set(`${event.signer}|${event.chainId}`, {
            signer: event.signer,
            chainId: event.chainId,
            agentId: event.agentId,
          });
        }
      } catch (error) {
        result.errors += 1;
        unstored.add(run.id);
        this.options.logger?.error('run ingest failed', { runId: run.id, error });
      }
    }

    result.touched = [...touched.values()];

    const advanced = nextHighWater(fresh, highWater, (run) => unstored.has(run.id));
    if (advanced) await setCursor(this.options.db, this.cursorKey, advanced);

    return result;
  }
}

/**
 * Where the mark may safely move to.
 *
 * Two kinds of run must be seen again, and the mark only ever moves forward, so
 * it stops just short of the earliest of them:
 *
 * - one still `pending` or `running`, which has no outcome yet, and the outcome
 *   is the part detection cares about;
 * - one this sweep failed to store, which would otherwise be skipped forever
 *   because a transient database error moved the mark past it.
 *
 * A run that keeps failing therefore holds the mark still. That costs repeated
 * work — every sweep re-reads everything newer — but it never loses a run, and
 * the failure is logged each time rather than buried. Re-reading is cheap by
 * design: events dedupe on (sourceId, attemptIndex).
 *
 * A run skipped for naming a chain we cannot read is *not* a blocker. It will
 * never become storable, and treating it as one would freeze ingestion for good.
 */
export function nextHighWater(
  runs: readonly KeeperHubRun[],
  current: string | null,
  mustRevisit: (run: KeeperHubRun) => boolean = () => false,
): string | null {
  if (runs.length === 0) return null;

  const newest = runs.reduce((max, r) => (r.startedAt > max ? r.startedAt : max), runs[0]!.startedAt);
  const blockers = runs.filter((r) => !TERMINAL.has(r.status) || mustRevisit(r));
  if (blockers.length === 0) return newest;

  const earliestBlocker = blockers.reduce(
    (min, r) => (r.startedAt < min ? r.startedAt : min),
    blockers[0]!.startedAt,
  );
  const justBefore = new Date(Date.parse(earliestBlocker) - 1).toISOString();
  // Never move the mark backwards; that would re-ingest settled history every
  // sweep for as long as one run stayed stuck.
  if (current && justBefore <= current) return current;
  return justBefore;
}
