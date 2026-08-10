import { useSyncExternalStore } from 'react';

/**
 * A single clock for every relative timestamp on the page.
 *
 * "2m ago" has to keep being true, and a per-row interval would mean one timer
 * per incident all firing on their own schedules. One shared tick redraws them
 * together, and stops entirely when nothing is watching.
 */

const listeners = new Set<() => void>();
let snapshot = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (!timer) {
    timer = setInterval(() => {
      snapshot = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}
