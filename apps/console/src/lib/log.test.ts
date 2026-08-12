import { describe, expect, it } from 'vitest';
import { LOG_CAP, appendLine, logLine, type LogLine } from './log';
import type { IncidentSummary, StreamEvent } from './types';

const incident = (over: Partial<IncidentSummary> = {}): IncidentSummary =>
  ({
    id: 'inc-1',
    class: 'NONCE_GAP',
    severity: 'critical',
    status: 'open',
    agentId: 'chaos',
    signer: '0xb9c58185d09d0acf3b237cd45c67345e32e628ba',
    chainId: 11155111,
    summary: 'Nonce 47 unfilled; 1 action blocked behind it',
    detectedAt: '2026-08-12T10:00:00.000Z',
    lastSeenAt: '2026-08-12T10:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    confidence: 0.9,
    ruleId: 'R2',
    hasRca: false,
    remediationStatus: null,
    remediationTxHash: null,
    ...over,
  }) as IncidentSummary;

describe('the stream as text', () => {
  it('says what was caught, and how bad', () => {
    const line = logLine({ type: 'incident.created', data: incident() });
    expect(line).toMatchObject({ tag: 'CRIT', tone: 'critical' });
    expect(line?.text).toContain('NONCE_GAP');
    expect(line?.text).toContain('Nonce 47 unfilled');
  });

  it('tones a warning apart from a failure', () => {
    expect(logLine({ type: 'incident.created', data: incident({ severity: 'warning' }) })).toMatchObject(
      { tag: 'WARN', tone: 'warning' },
    );
    expect(logLine({ type: 'incident.created', data: incident({ severity: 'info' }) })).toMatchObject({
      tag: 'INFO',
      tone: 'plain',
    });
  });

  it('marks a resolution as good news and a failed fix as bad', () => {
    expect(
      logLine({ type: 'incident.updated', data: incident({ status: 'resolved' }) }),
    ).toMatchObject({ tone: 'good' });
    expect(
      logLine({
        type: 'remediation.failed',
        data: { incidentId: 'inc-1', reason: 'guard refused' },
      }),
    ).toMatchObject({ tone: 'critical' });
  });

  it('shortens a transaction hash rather than wrapping one across the pane', () => {
    const line = logLine({
      type: 'remediation.succeeded',
      data: { incidentId: 'inc-1', txHash: `0x${'a'.repeat(64)}` },
    });
    expect(line?.text).toContain(`0x${'a'.repeat(10)}…`);
    expect(line?.text).not.toContain('a'.repeat(64));
  });

  it('logs a scan, which never becomes an incident and is the point of the panel', () => {
    const line = logLine({
      type: 'scan.progress',
      data: { fromBlock: 10, toBlock: 20, blocksScanned: 11, matched: 2, watching: 3 },
    });
    expect(line?.tag).toBe('scan');
    expect(line?.text).toContain('blocks 10–20');
  });

  it('stays silent about stats, which would drown everything else', () => {
    // A recomputation of numbers already on screen, arriving constantly.
    expect(logLine({ type: 'stats.updated', data: {} as never })).toBeNull();
  });

  it('gives every line its own key, even within a millisecond', () => {
    const a = logLine({ type: 'incident.created', data: incident() }, 1000);
    const b = logLine({ type: 'incident.created', data: incident() }, 1000);
    expect(a?.key).not.toBe(b?.key);
  });
});

describe('appending', () => {
  const line = (n: number): LogLine => ({ key: `k${n}`, at: n, tag: 't', text: `${n}`, tone: 'plain' });

  it('keeps the newest at the end', () => {
    const log = appendLine(appendLine([], line(1)), line(2));
    expect(log.map((l) => l.text)).toEqual(['1', '2']);
  });

  it('drops the oldest rather than growing without bound', () => {
    let log: readonly LogLine[] = [];
    for (let i = 0; i < LOG_CAP + 25; i += 1) log = appendLine(log, line(i));
    expect(log).toHaveLength(LOG_CAP);
    expect(log[0]?.text).toBe('25');
    expect(log[log.length - 1]?.text).toBe(String(LOG_CAP + 24));
  });

  it('leaves the log alone when an event produced no line', () => {
    const log = appendLine([], line(1));
    expect(appendLine(log, null)).toBe(log);
  });
});

/** Nothing above should have needed a real event type to be invented. */
const _typecheck: StreamEvent['type'][] = [
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
];
void _typecheck;
