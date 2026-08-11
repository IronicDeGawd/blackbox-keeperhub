import { useSyncExternalStore } from 'react';
import { ApiError, api, type IncidentFilters } from './api';
import { openStream, type Stream } from './sse';
import type {
  AppConfig,
  ConnectionState,
  IncidentSummary,
  ScanProgress,
  Stats,
  StreamEvent,
} from './types';

/**
 * One store for everything the shell and the timeline read: config, stats, the
 * incident list, and the state of the feed carrying updates to all three.
 *
 * The list holds exactly the incidents matching the current filters, and the
 * filters are applied twice — once by the server on fetch, and once here when a
 * pushed incident arrives. Without the second one a live update would either be
 * dropped when it should appear, or appear in a view that excludes it. An
 * incident that stops matching is removed, because a row that no longer belongs
 * in the view is worse than no row.
 */

export type ListStatus = 'idle' | 'loading' | 'ready' | 'error';

export type ConsoleState = {
  config: AppConfig | null;
  configError: ApiError | null;
  incidents: IncidentSummary[];
  stats: Stats | null;
  connection: ConnectionState;
  listStatus: ListStatus;
  error: ApiError | null;
  scan: ScanProgress | null;
  /** Set whenever the feed reopens, so the UI can say the list was replayed. */
  lastRefetchAt: string | null;
  /**
   * The last incident an event named, and when. The detail page watches this to
   * re-read itself: an incident it is showing may not be in the filtered list
   * at all, so the list is not a reliable signal that it changed.
   */
  lastTouched: { id: string; at: number } | null;
};

const initial: ConsoleState = {
  config: null,
  configError: null,
  incidents: [],
  stats: null,
  connection: 'connecting',
  listStatus: 'idle',
  error: null,
  scan: null,
  lastRefetchAt: null,
  lastTouched: null,
};

let state: ConsoleState = initial;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function set(patch: Partial<ConsoleState>): void {
  state = { ...state, ...patch };
  emit();
}

// ------------------------------------------------------------------ filtering

let filters: IncidentFilters = {};
let request = 0;
let everLoaded = false;

/**
 * The same predicate the server applies, repeated on the client for incidents
 * that arrive by push instead of by fetch. A signer is compared case-insensitively
 * because a UI sends it checksummed and the store holds it lowercased.
 */
export function matchesFilters(incident: IncidentSummary, active: IncidentFilters): boolean {
  if (active.status && incident.status !== active.status) return false;
  if (active.class && incident.class !== active.class) return false;
  if (active.severity && incident.severity !== active.severity) return false;
  if (active.agentId && incident.agentId !== active.agentId) return false;
  if (active.chainId !== undefined && incident.chainId !== active.chainId) return false;
  if (active.signer && incident.signer.toLowerCase() !== active.signer.toLowerCase()) {
    return false;
  }
  return true;
}

const newestFirst = (a: IncidentSummary, b: IncidentSummary): number =>
  Date.parse(b.detectedAt) - Date.parse(a.detectedAt);

function upsert(incident: IncidentSummary): void {
  const without = state.incidents.filter((i) => i.id !== incident.id);
  const next = matchesFilters(incident, filters)
    ? [...without, incident].sort(newestFirst)
    : without;
  set({ incidents: next });
}

// --------------------------------------------------------------------- loading

async function loadIncidents(): Promise<void> {
  // Only the newest request may write. A filter change during a slow fetch
  // would otherwise land the old result on top of the new view.
  const ticket = (request += 1);
  set({ listStatus: state.listStatus === 'ready' ? 'ready' : 'loading', error: null });

  try {
    const list = await api.incidents(filters);
    if (ticket !== request) return;
    set({ incidents: [...list.items].sort(newestFirst), listStatus: 'ready', error: null });
  } catch (cause) {
    if (ticket !== request) return;
    set({
      listStatus: 'error',
      error:
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'unknown', String(cause), null, cause),
    });
  }
}

async function loadConfig(): Promise<void> {
  try {
    set({ config: await api.config(), configError: null });
  } catch (cause) {
    if (cause instanceof ApiError) set({ configError: cause });
  }
}

async function loadStats(): Promise<void> {
  try {
    set({ stats: await api.stats() });
  } catch {
    // The stats strip degrades to em dashes on its own; a failure here must not
    // take the incident list down with it.
  }
}

// ---------------------------------------------------------------------- events

function touch(id: string): void {
  set({ lastTouched: { id, at: Date.now() } });
}

function applyEvent(event: StreamEvent): void {
  switch (event.type) {
    case 'incident.created':
    case 'incident.updated':
      upsert(event.data);
      touch(event.data.id);
      break;

    case 'remediation.started':
    case 'remediation.failed':
      touch(event.data.incidentId);
      break;

    case 'stats.updated':
      // The event carries the whole object, so there is nothing to refetch.
      set({ stats: event.data });
      break;

    case 'scan.progress':
      set({ scan: event.data });
      break;

    case 'remediation.succeeded': {
      // Arrives just before the incident update that also carries it. Patching
      // now means the hash appears the moment it exists.
      const { incidentId, txHash, explorerUrl } = event.data;
      const incidents = state.incidents.map((incident) =>
        incident.id === incidentId
          ? { ...incident, remediationTxHash: txHash, explorerUrl: explorerUrl ?? null }
          : incident,
      );
      set({ incidents });
      touch(incidentId);
      break;
    }

    default:
      break;
  }
}

// ----------------------------------------------------------------------- stream

let stream: Stream | null = null;
let subscribers = 0;

function connect(): void {
  if (stream) return;
  stream = openStream({
    onEvent: applyEvent,
    onState: (connection: ConnectionState) => set({ connection }),
    onOpen: (reopened: boolean) => {
      if (!reopened) return;
      // Everything published during the gap is unrecoverable, so the list and
      // the counters are re-read rather than patched forward.
      set({ lastRefetchAt: new Date().toISOString() });
      void loadIncidents();
      void loadStats();
    },
  });
}

function disconnect(): void {
  stream?.close();
  stream = null;
}

// ------------------------------------------------------------------------ api

export const store = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    subscribers += 1;
    connect();
    return () => {
      listeners.delete(listener);
      subscribers -= 1;
      if (subscribers === 0) disconnect();
    };
  },

  getSnapshot: (): ConsoleState => state,

  /**
   * Replaces the active filters and reloads. Unchanged filters are a no-op,
   * except for the first call — the initial view has to be fetched even when
   * nothing is filtered.
   */
  setFilters(next: IncidentFilters): void {
    if (everLoaded && JSON.stringify(next) === JSON.stringify(filters)) return;
    everLoaded = true;
    filters = next;
    void loadIncidents();
  },

  refresh(): void {
    void loadIncidents();
    void loadStats();
  },

  start(): void {
    void loadConfig();
    void loadStats();
  },

  /** Exposed for the detail page, which patches a row it has just changed. */
  apply(incident: IncidentSummary): void {
    upsert(incident);
  },
};

export function useConsole(): ConsoleState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
