/**
 * In-process event bus behind the SSE stream.
 *
 * The console is a live view of a loop that is already running, so the API does
 * not poll for changes — the recorder, the remediation loop and the chaos
 * endpoints publish here, and every connected client is told at once.
 *
 * Deliberately in-process and unbuffered. A subscriber that connects late has
 * missed what happened, which is why the console refetches the list on
 * reconnect rather than expecting replay: pretending an in-memory bus is a
 * durable log is how a UI ends up confidently showing a stale world.
 */

export type BlackboxEvent =
  | { type: 'incident.created'; data: unknown }
  | { type: 'incident.updated'; data: unknown }
  | { type: 'remediation.started'; data: unknown }
  | { type: 'remediation.succeeded'; data: unknown }
  | { type: 'remediation.failed'; data: unknown }
  | { type: 'chaos.started'; data: unknown }
  | { type: 'chaos.completed'; data: unknown }
  | { type: 'scan.progress'; data: unknown }
  | { type: 'stats.updated'; data: unknown };

export type Subscriber = (event: BlackboxEvent) => void;

export class EventBus {
  private readonly subscribers = new Set<Subscriber>();

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  publish(event: BlackboxEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // One broken client — a socket that closed mid-write — must not stop
        // the others being told, and must never propagate into the code that
        // was doing real work when it published.
      }
    }
  }
}
