import { describe, expect, it } from 'vitest';
import { executionIdsFrom, toSteps } from './run-log.js';

const event = (over: Record<string, unknown> = {}) => ({
  agentKind: 'keeperhub' as string | null,
  raw: { id: 'exec-1' } as unknown,
  ...over,
});

describe('finding the runs behind an incident', () => {
  it('answers newest first, because that is the run that caused it', () => {
    // The store hands events over oldest-first.
    const events = [
      event({ raw: { id: 'oldest' } }),
      event({ raw: { id: 'middle' } }),
      event({ raw: { id: 'newest' } }),
    ];
    expect(executionIdsFrom(events)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('counts one run once, however many events it produced', () => {
    const events = [event(), event(), event()];
    expect(executionIdsFrom(events)).toEqual(['exec-1']);
  });

  it('ignores anything that is not a KeeperHub run', () => {
    // A chain-observed event has no execution to ask about, and an event
    // recorded before agentKind existed reads as unknown rather than as one.
    const events = [
      event({ agentKind: 'eoa', raw: { id: 'from-the-chain' } }),
      event({ agentKind: null, raw: { id: 'from-before' } }),
      event({ raw: { id: 'real' } }),
    ];
    expect(executionIdsFrom(events)).toEqual(['real']);
  });

  it('survives evidence with no usable id on it', () => {
    const events = [
      event({ raw: null }),
      event({ raw: 'not an object' }),
      event({ raw: {} }),
      event({ raw: { id: '' } }),
      event({ raw: { id: 42 } }),
    ];
    expect(executionIdsFrom(events)).toEqual([]);
  });

  it('stops at the limit, since each id costs a request to their API', () => {
    const events = Array.from({ length: 12 }, (_, i) => event({ raw: { id: `e${i}` } }));
    expect(executionIdsFrom(events)).toHaveLength(5);
    expect(executionIdsFrom(events, 2)).toEqual(['e11', 'e10']);
  });
});

describe('shaping a run into steps', () => {
  it('makes every absent field an explicit null', () => {
    // Most steps send no transaction. A missing key renders as nothing, which
    // reads as a bug; a null renders as "none", which is the truth.
    expect(
      toSteps([
        { nodeId: 'n1', nodeType: 'trigger', status: 'success' },
        {
          nodeId: 'n2',
          nodeType: 'contract-call',
          status: 'failed',
          output: { transactionHash: '0xabc', gasUsed: '21000', sponsored: true },
        },
      ]),
    ).toEqual([
      {
        nodeId: 'n1',
        nodeType: 'trigger',
        status: 'success',
        txHash: null,
        gasUsed: null,
        sponsored: null,
      },
      {
        nodeId: 'n2',
        nodeType: 'contract-call',
        status: 'failed',
        txHash: '0xabc',
        gasUsed: '21000',
        sponsored: true,
      },
    ]);
  });

  it('keeps the order the run reported', () => {
    const steps = toSteps([
      { nodeId: 'a', nodeType: 't', status: 'success' },
      { nodeId: 'b', nodeType: 't', status: 'success' },
      { nodeId: 'c', nodeType: 't', status: 'failed' },
    ]);
    expect(steps.map((s) => s.nodeId)).toEqual(['a', 'b', 'c']);
  });
});
