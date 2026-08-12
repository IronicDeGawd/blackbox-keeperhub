/**
 * The steps behind a run, as KeeperHub recorded them.
 *
 * An incident says a run failed. The next question an operator asks is *which
 * step, and what did it say* — and that answer already exists in
 * `/workflows/executions/{id}/logs`, which the client has always been able to
 * fetch and the console has never shown. Until this existed the incident page
 * sent people to KeeperHub's own dashboard to read data we hold.
 *
 * The extraction lives here rather than in the route so it can be tested
 * without a database or a provider.
 */

/** One node in a run: what it was, how it ended, and what it cost. */
export type RunLogStep = {
  nodeId: string;
  nodeType: string;
  status: string;
  txHash: string | null;
  gasUsed: string | null;
  sponsored: boolean | null;
};

export type RunLogEntry = {
  executionId: string;
  status: string;
  error: string | null;
  steps: RunLogStep[];
};

/** Just enough of a stored event to find the run it came from. */
type EventLike = {
  agentKind: string | null;
  raw: unknown;
  sourceId?: string | null;
};

/**
 * The KeeperHub execution ids behind an incident's evidence, newest first.
 *
 * Evidence is often several events from one run, and for a retry storm it is
 * several runs — so this dedupes, and the caller decides how many tails are
 * worth fetching. Events arrive oldest-first from the store; the reversal here
 * is what makes "the run that caused this" the first entry.
 *
 * Chain-observed events carry no KeeperHub run, and events from before the
 * `agentKind` distinction existed carry null. Both are skipped rather than
 * guessed at: asking KeeperHub for an id it never issued costs a request and
 * answers 404.
 */
export function executionIdsFrom(events: readonly EventLike[], limit = 5): string[] {
  const ids: string[] = [];
  for (const event of [...events].reverse()) {
    if (event.agentKind !== 'keeperhub') continue;
    const raw = event.raw;
    if (typeof raw !== 'object' || raw === null) continue;
    const id = (raw as { id?: unknown }).id;
    if (typeof id !== 'string' || id === '') continue;
    if (ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

/**
 * Normalise the client's node results into something the console can render.
 *
 * Every optional field becomes an explicit null. A step that produced no
 * transaction is a fact worth showing — most of them do not — and a missing
 * key renders as nothing at all, which reads as a bug rather than as a step
 * that simply did not send anything.
 */
export function toSteps(
  logs: readonly {
    nodeId: string;
    nodeType: string;
    status: string;
    output?: { transactionHash?: string; gasUsed?: string; sponsored?: boolean } | null;
  }[],
): RunLogStep[] {
  return logs.map((log) => ({
    nodeId: log.nodeId,
    nodeType: log.nodeType,
    status: log.status,
    txHash: log.output?.transactionHash ?? null,
    gasUsed: log.output?.gasUsed ?? null,
    sponsored: log.output?.sponsored ?? null,
  }));
}
