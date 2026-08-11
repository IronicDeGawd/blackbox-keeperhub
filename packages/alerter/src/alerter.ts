import type { Incident } from '@blackbox/core';
import { alertFor, remember, type Alert, type AlertMemory } from './alert.js';
import { DEFAULT_POLICY, selectRoutes, type RoutingPolicy } from './routing.js';

/**
 * Somewhere an alert can be delivered. Deliberately tiny: a channel does one
 * thing, and anything that can post a JSON body can be one.
 */
export type Channel = {
  name: string;
  deliver(alert: Alert): Promise<void>;
};

export type AlerterOptions = {
  channels: readonly Channel[];
  policy?: RoutingPolicy;
  now?: () => Date;
  logger?: { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
  /**
   * Where the "what did we last say" record lives. In memory by default, which
   * means a restart re-announces open incidents once. That is the safer failure
   * — silence about a live problem is worse than saying it twice — and a
   * durable store can be supplied when that trade stops being acceptable.
   */
  memory?: Map<string, AlertMemory>;
};

export type DeliveryResult = {
  alert: Alert | null;
  delivered: string[];
  failed: string[];
};

/**
 * Turns incidents into alerts and gets them out of the process.
 *
 * Detection without delivery is half a product: nobody watches a dashboard at
 * 3am. This is the half that means an operator finds out.
 */
export class Alerter {
  private readonly memory: Map<string, AlertMemory>;
  private readonly now: () => Date;

  constructor(private readonly options: AlerterOptions) {
    this.memory = options.memory ?? new Map();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Consider one incident. Returns what was said and where it went — including
   * the common answer, which is nothing.
   */
  async consider(incident: Incident): Promise<DeliveryResult> {
    const alert = alertFor(incident, this.memory.get(incident.id), this.now());
    if (!alert) return { alert: null, delivered: [], failed: [] };

    const routes = selectRoutes(alert, this.options.policy ?? DEFAULT_POLICY);
    const wanted = new Set(routes.map((r) => r.channel));
    const targets = this.options.channels.filter((c) => wanted.has(c.name));

    const delivered: string[] = [];
    const failed: string[] = [];
    for (const channel of targets) {
      try {
        await channel.deliver(alert);
        delivered.push(channel.name);
      } catch (error) {
        // One dead channel must not stop the others, and must not stop the
        // incident being marked as announced — re-announcing everything because
        // Discord was down is how an alerter becomes the noise it exists to
        // prevent.
        failed.push(channel.name);
        this.options.logger?.error('alert delivery failed', {
          channel: channel.name,
          incidentId: incident.id,
          error,
        });
      }
    }

    /**
     * Remembered even when no route wanted it. The alert was correctly
     * suppressed by policy, and treating it as unsaid would make the next tick
     * reconsider it as new — so a warning during quiet hours would become a
     * page the moment quiet hours ended.
     */
    this.memory.set(incident.id, remember(alert));

    return { alert, delivered, failed };
  }

  /** Consider many, in order. Used by the recorder at the end of a tick. */
  async considerAll(incidents: readonly Incident[]): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];
    for (const incident of incidents) {
      results.push(await this.consider(incident));
    }
    return results;
  }
}
