import type { ConnectionState, StreamEvent } from './types';
import { streamUrl } from './api';

/**
 * The event stream.
 *
 * Reconnection is driven here rather than left to EventSource. The browser's
 * own retry is invisible and unpaced, and the console has to answer two
 * questions it cannot answer from the inside: is this feed live right now, and
 * what did we miss while it was not. So the socket is closed on error and
 * reopened on a backoff, and every reopen reports itself as a reopen — the
 * caller refetches the list, because events that arrived during the gap are
 * gone and no replay exists.
 *
 * Comment frames (`: ping`, every 15s) are keepalive, not events. EventSource
 * discards them without telling anyone, which is the behaviour we want.
 */

const EVENT_NAMES = [
  'hello',
  'incident.created',
  'incident.updated',
  'remediation.started',
  'remediation.succeeded',
  'remediation.failed',
  'chaos.started',
  'chaos.completed',
  'scan.progress',
  'stats.updated',
] as const;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

export type StreamHandlers = {
  onEvent: (event: StreamEvent) => void;
  onState: (state: ConnectionState) => void;
  /** Fired on every successful open. `reopened` is false only the first time. */
  onOpen: (reopened: boolean) => void;
};

export type Stream = { close: () => void };

export function openStream(handlers: StreamHandlers): Stream {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let opened = false;
  let closed = false;

  const connect = (): void => {
    if (closed) return;
    handlers.onState(attempt === 0 ? 'connecting' : 'reconnecting');

    const es = new EventSource(streamUrl());
    source = es;

    es.onopen = () => {
      attempt = 0;
      handlers.onState('connected');
      handlers.onOpen(opened);
      opened = true;
    };

    es.onerror = () => {
      // EventSource would retry on its own schedule; take it over so the delay
      // is paced and the state is reportable.
      es.close();
      if (source === es) source = null;
      if (closed) return;
      handlers.onState(attempt >= 4 ? 'disconnected' : 'reconnecting');
      schedule();
    };

    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (message) => {
        const raw = (message as MessageEvent<string>).data;
        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          // A frame we cannot parse is not worth tearing the stream down for.
          return;
        }
        handlers.onEvent({ type: name, data } as StreamEvent);
      });
    }
  };

  const schedule = (): void => {
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
    // Jitter keeps a restarted server from being hit by every console at once.
    const jittered = delay * (0.75 + Math.random() * 0.5);
    attempt += 1;
    timer = setTimeout(connect, jittered);
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      source?.close();
      source = null;
    },
  };
}
