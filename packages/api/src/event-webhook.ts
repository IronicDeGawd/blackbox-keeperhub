import { createHmac } from 'node:crypto';
import type { BlackboxEvent, EventBus } from './bus.js';

/**
 * Raw events, pushed to a URL the operator controls.
 *
 * The alerter answers "tell a person something happened". This answers a
 * different question: "give my system the events". An alert is edited for
 * humans — deduplicated, severity-filtered, written as a sentence — and that
 * editing is exactly wrong for a pipeline that wants everything, in order,
 * untouched.
 *
 * SSE already serves a browser watching live. This serves a consumer that is
 * not always connected, which is the case SSE cannot cover: a subscriber that
 * connects late has missed what it missed.
 */

export type EventWebhookOptions = {
  url: string;
  /**
   * Signs the body, so a receiver can tell our delivery from anyone who has
   * learned the URL. Without it the endpoint is only as private as its address.
   */
  secret?: string;
  /** Event types to send. Absent means everything the bus carries. */
  types?: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
  logger?: { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
  /** Deliveries in flight at once. Beyond this, events are dropped and counted. */
  maxInFlight?: number;
};

/**
 * `t=<unix seconds>,v1=<hex hmac of "t.body">`.
 *
 * The timestamp is inside the signed string, so a captured delivery cannot be
 * replayed later with a fresh timestamp — changing it invalidates the
 * signature. A receiver should reject anything older than its own tolerance.
 */
export function signPayload(body: string, secret: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export class EventWebhook {
  private inFlight = 0;
  /** Counted rather than silently ignored; a dropped event is a real gap. */
  private dropped = 0;
  private delivered = 0;
  private failed = 0;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly options: EventWebhookOptions) {}

  get stats(): { delivered: number; failed: number; dropped: number } {
    return { delivered: this.delivered, failed: this.failed, dropped: this.dropped };
  }

  attach(bus: EventBus): () => void {
    this.unsubscribe = bus.subscribe((event) => {
      void this.deliver(event);
    });
    return () => this.detach();
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async deliver(event: BlackboxEvent): Promise<void> {
    if (this.options.types && !this.options.types.includes(event.type)) return;

    /**
     * A slow or dead receiver must not become this process's problem. Delivery
     * is fire-and-forget with a ceiling: past it, events are dropped and
     * counted, because an unbounded queue of pending fetches is how a webhook
     * takes down the thing it was watching.
     */
    const ceiling = this.options.maxInFlight ?? 32;
    if (this.inFlight >= ceiling) {
      this.dropped += 1;
      this.options.logger?.error('event webhook saturated, dropping event', {
        type: event.type,
        dropped: this.dropped,
      });
      return;
    }

    const at = this.options.now?.() ?? new Date();
    const body = JSON.stringify({
      type: event.type,
      data: event.data,
      at: at.toISOString(),
    });

    this.inFlight += 1;
    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const res = await fetchImpl(this.options.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Blackbox-Event': event.type,
          ...(this.options.secret
            ? { 'X-Blackbox-Signature': signPayload(body, this.options.secret, at) }
            : {}),
        },
        body,
      });
      if (!res.ok) throw new Error(`receiver answered ${res.status}`);
      this.delivered += 1;
    } catch (error) {
      this.failed += 1;
      // Not retried. A retry queue that outlives the process would need
      // durability, and an event stream nobody guarantees is better than one
      // that pretends to.
      this.options.logger?.error('event webhook delivery failed', { type: event.type, error });
    } finally {
      this.inFlight -= 1;
    }
  }
}
