import { describe, expect, it, vi } from 'vitest';
import { CHAIN_IDS, type Incident } from '@blackbox/core';
import { privateKeyToAccount } from 'viem/accounts';
import { TransactionReceiptNotFoundError } from 'viem';
import type { PlaybookPlan } from '../playbooks.js';
import { KeeperHubExecutor, type KeeperHubSubmitter } from './keeperhub.js';
import { SignerExecutor } from './signer.js';
import { RoutingExecutor } from './routing.js';
import { WorkflowExecutor, type WorkflowClient } from './workflow.js';
import { ReceiptVerifier } from './verify.js';

const ACCOUNT = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const OTHER = '0x00000000000000000000000000000000000000ff' as `0x${string}`;
const TX = `0x${'a'.repeat(64)}` as `0x${string}`;
const T0 = new Date('2026-08-10T12:00:00.000Z');

const incident = (over: Partial<Incident> = {}): Incident =>
  ({
    id: 'inc-1',
    class: 'NONCE_GAP',
    severity: 'critical',
    status: 'open',
    agentId: 'chaos',
    signer: ACCOUNT.address,
    chainId: CHAIN_IDS.sepolia,
    detectedAt: T0,
    firstEventAt: T0,
    confidence: 0.9,
    evidence: { eventIds: ['e0'], ruleId: 'R2', facts: {} },
    ...over,
  }) as Incident;

const submitPlan = (over: Partial<Extract<PlaybookPlan, { kind: 'submit' }>> = {}) =>
  ({
    kind: 'submit',
    description: 'test plan',
    to: OTHER,
    value: 0n,
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 10n,
    route: 'public',
    ...over,
  }) as Extract<PlaybookPlan, { kind: 'submit' }>;

const stubSubmitter = (over: Partial<KeeperHubSubmitter> = {}): KeeperHubSubmitter => ({
  transfer: vi.fn(async () => ({ executionId: 'exec-1', transactionHash: TX })),
  writeContract: vi.fn(async () => ({ executionId: 'exec-2', transactionHash: TX })),
  ...over,
});

const verifier = () => new ReceiptVerifier({ [CHAIN_IDS.sepolia]: 'http://unused' });

describe('KeeperHubExecutor', () => {
  it('refuses any plan that names a nonce, because it submits via a sponsored relayer', async () => {
    const executor = new KeeperHubExecutor(stubSubmitter(), verifier());
    await expect(
      executor.submit({ plan: submitPlan({ nonce: 42 }), incident: incident() }),
    ).rejects.toThrow(/cannot submit at a chosen nonce/i);
  });

  it('names the signer and the required nonce in the refusal so the router can act on it', async () => {
    const executor = new KeeperHubExecutor(stubSubmitter(), verifier());
    await expect(
      executor.submit({ plan: submitPlan({ nonce: 7 }), incident: incident() }),
    ).rejects.toThrow(new RegExp(`${ACCOUNT.address}[\\s\\S]*nonce 7|nonce 7`, 'i'));
  });

  it('sends a value-only plan through the transfer endpoint', async () => {
    const client = stubSubmitter();
    const executor = new KeeperHubExecutor(client, verifier());
    const result = await executor.submit({
      plan: submitPlan({ value: 1_000_000_000_000_000_000n }),
      incident: incident(),
    });
    expect(client.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'sepolia', recipientAddress: OTHER, amount: '1' }),
    );
    expect(result).toMatchObject({ txHash: TX, keeperHubActionId: 'exec-1', executor: 'keeperhub' });
  });

  it('sends an ABI-level call through the contract-call endpoint', async () => {
    const client = stubSubmitter();
    const executor = new KeeperHubExecutor(client, verifier());
    await executor.submit({
      plan: submitPlan({ data: '0x8456cb59', call: { functionName: 'pause', args: [] } }),
      incident: incident(),
    });
    expect(client.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        network: 'sepolia',
        contractAddress: OTHER,
        functionName: 'pause',
        functionArgs: '[]',
      }),
    );
  });

  it('throws rather than reporting a remediation when no hash can be obtained', async () => {
    const client = stubSubmitter({
      transfer: vi.fn(async () => ({ executionId: 'exec-9' })),
    });
    const executor = new KeeperHubExecutor(client, verifier(), {
      hashLookupAttempts: 1,
      sleep: async () => {},
    });
    await expect(executor.submit({ plan: submitPlan(), incident: incident() })).rejects.toThrow(
      /no transaction hash/i,
    );
  });

  it('looks the hash up when the submission response omits it', async () => {
    // A live pause() came back `completed` with no hash while the transaction
    // was already on chain, so a real remediation was recorded as failed.
    const getExecutionStatus = vi
      .fn()
      .mockResolvedValueOnce({ transactionHash: null })
      .mockResolvedValueOnce({ transactionHash: TX });
    const client = stubSubmitter({
      writeContract: vi.fn(async () => ({ executionId: 'exec-2' })),
      getExecutionStatus,
    });
    const executor = new KeeperHubExecutor(client, verifier(), {
      hashLookupAttempts: 3,
      sleep: async () => {},
    });

    const result = await executor.submit({
      plan: submitPlan({ call: { functionName: 'pause', args: [] } }),
      incident: incident(),
    });
    expect(result).toMatchObject({ txHash: TX, keeperHubActionId: 'exec-2', executor: 'keeperhub' });
    expect(getExecutionStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps asking when a status lookup throws', async () => {
    const getExecutionStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce({ transactionHash: TX });
    const client = stubSubmitter({
      transfer: vi.fn(async () => ({ executionId: 'exec-3' })),
      getExecutionStatus,
    });
    const executor = new KeeperHubExecutor(client, verifier(), {
      hashLookupAttempts: 3,
      sleep: async () => {},
    });
    await expect(
      executor.submit({ plan: submitPlan(), incident: incident() }),
    ).resolves.toMatchObject({ txHash: TX, keeperHubActionId: 'exec-3', executor: 'keeperhub' });
  });
});

describe('SignerExecutor', () => {
  it('refuses a signer whose key it does not hold', async () => {
    const executor = new SignerExecutor([], {}, verifier());
    await expect(
      executor.submit({ plan: submitPlan({ nonce: 3 }), incident: incident() }),
    ).rejects.toThrow(/no key held/i);
  });

  it('submits at the exact nonce and fees the playbook planned', async () => {
    const sendTransaction = vi.fn(async () => TX);
    const executor = new SignerExecutor(
      [ACCOUNT],
      {},
      verifier(),
      () => ({ sendTransaction }) as never,
    );
    const result = await executor.submit({
      plan: submitPlan({ nonce: 41, maxFeePerGas: 999n, maxPriorityFeePerGas: 5n }),
      incident: incident(),
    });
    expect(result).toEqual({ txHash: TX, executor: 'signer' });
    expect(sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 41, maxFeePerGas: 999n, maxPriorityFeePerGas: 5n }),
    );
  });

  it('matches the held key case-insensitively', () => {
    const executor = new SignerExecutor([ACCOUNT], {}, verifier());
    expect(executor.holdsKeyFor(ACCOUNT.address.toUpperCase())).toBe(true);
  });
});

describe('RoutingExecutor', () => {
  const kh = { submit: vi.fn(), verify: vi.fn() };
  const signer = { submit: vi.fn(), verify: vi.fn(), holdsKeyFor: () => true };

  it('routes a nonce-precise plan to the key-holding executor', () => {
    const router = new RoutingExecutor({ keeperHub: kh, signer });
    expect(router.route(submitPlan({ nonce: 41 }), incident())).toBe(signer);
  });

  it('prefers KeeperHub when the plan does not need a nonce', () => {
    const router = new RoutingExecutor({ keeperHub: kh, signer });
    expect(router.route(submitPlan(), incident())).toBe(kh);
  });

  it('explains why a nonce-precise plan cannot run when no key is held', () => {
    const router = new RoutingExecutor({
      keeperHub: kh,
      signer: { ...signer, holdsKeyFor: () => false },
    });
    expect(() => router.route(submitPlan({ nonce: 41 }), incident())).toThrow(
      /sponsored relayer[\s\S]*no key is held/i,
    );
  });

  it('falls back to the key-holding executor when KeeperHub is not configured', () => {
    const router = new RoutingExecutor({ signer });
    expect(router.route(submitPlan(), incident())).toBe(signer);
  });
});

describe('ReceiptVerifier', () => {
  const receiptClient = (receipts: unknown[]) => {
    let i = 0;
    return {
      getTransactionReceipt: vi.fn(async () => {
        const next = receipts[i];
        i = Math.min(i + 1, receipts.length - 1);
        if (next instanceof Error) throw next;
        return next;
      }),
    };
  };

  const build = (client: unknown, now: () => number) => {
    const verifier = new ReceiptVerifier(
      { [CHAIN_IDS.sepolia]: 'http://unused' },
      async () => {},
      0,
      now,
    );
    vi.spyOn(verifier, 'client').mockReturnValue(client as never);
    return verifier;
  };

  it('reports a reverted receipt as not included', async () => {
    const verifier = build(receiptClient([{ status: 'reverted', gasUsed: 21_000n }]), () => 0);
    await expect(
      verifier.waitForReceipt({ txHash: TX, chainId: CHAIN_IDS.sepolia, timeoutMs: 1000 }),
    ).resolves.toEqual({ included: false, gasUsed: 21_000n });
  });

  it('keeps polling past a not-yet-mined error and then confirms', async () => {
    const client = receiptClient([new Error('not found'), { status: 'success', gasUsed: 21_000n }]);
    const verifier = build(client, () => 0);
    await expect(
      verifier.waitForReceipt({ txHash: TX, chainId: CHAIN_IDS.sepolia, timeoutMs: 1000 }),
    ).resolves.toEqual({ included: true, gasUsed: 21_000n });
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it('gives up at the deadline rather than waiting forever', async () => {
    let t = 0;
    // The node answering "there is no such receipt" is a real answer, so the
    // verdict is a plain not-included with nothing uncertain about it.
    const verifier = build(
      receiptClient([
        new TransactionReceiptNotFoundError({ hash: TX }),
        new TransactionReceiptNotFoundError({ hash: TX }),
      ]),
      () => (t += 600),
    );
    await expect(
      verifier.waitForReceipt({ txHash: TX, chainId: CHAIN_IDS.sepolia, timeoutMs: 1000 }),
    ).resolves.toEqual({ included: false });
  });

  it('will not call a remediation failed when it never managed to ask', async () => {
    // The dangerous case: the transaction may well have landed. Reporting a
    // flat `included: false` here writes a successful remediation into the
    // ledger as a failure, permanently.
    let t = 0;
    const verifier = build(
      receiptClient([new Error('fetch failed: ECONNRESET')]),
      () => (t += 600),
    );
    const result = await verifier.waitForReceipt({
      txHash: TX,
      chainId: CHAIN_IDS.sepolia,
      timeoutMs: 1000,
    });
    expect(result.included).toBe(false);
    expect(result.uncertain).toBe(true);
    expect(result.detail).toMatch(/could not reach a node/i);
  });

  it('refuses to verify on a chain it has no RPC for', () => {
    const verifier = new ReceiptVerifier({});
    expect(() => verifier.client(CHAIN_IDS.base)).toThrow(/No RPC URL configured/i);
  });
});

describe('WorkflowExecutor', () => {
  const stubClient = (over: Partial<WorkflowClient> = {}): WorkflowClient => ({
    listWorkflows: vi.fn(async () => []),
    createWorkflow: vi.fn(async () => ({ id: 'wf-1' })),
    patchWorkflow: vi.fn(async () => {}),
    executeWorkflow: vi.fn(async () => ({ executionId: 'exec-1' })),
    getWorkflowExecution: vi.fn(async () => ({
      status: 'success',
      error: null,
      logs: [{ nodeType: 'web3/write-contract', status: 'success', output: { transactionHash: TX } }],
    })),
    ...over,
  });

  const executor = (client: WorkflowClient) =>
    new WorkflowExecutor(client, verifier(), { sleep: async () => {}, pollAttempts: 3 });

  const pausePlan = submitPlan({
    call: { functionName: 'pause', args: [] },
    description: 'pause the circuit breaker',
  });

  it('provisions a workflow, enables it, runs it and returns the real hash', async () => {
    const client = stubClient();
    const result = await executor(client).submit({ plan: pausePlan, incident: incident() });

    expect(client.createWorkflow).toHaveBeenCalled();
    expect(result).toEqual({
      txHash: TX,
      keeperHubActionId: 'exec-1',
      executor: 'keeperhub-workflow',
    });
  });

  it('uses the field names workflow actions want, not the Direct Execution ones', async () => {
    const client = stubClient();
    await executor(client).submit({ plan: pausePlan, incident: incident() });

    const nodes = (client.createWorkflow as ReturnType<typeof vi.fn>).mock.calls[0][0].nodes;
    const config = nodes[1].data.config;
    expect(config.abiFunction).toBe('pause');
    expect(config.functionName).toBeUndefined();
  });

  it('sends arguments as functionArgs, the only field the runtime reads', async () => {
    // Their write-contract step reads `functionArgs` and never `args`. Sending
    // `args` saves without complaint and then calls the function with no
    // arguments at all — which a zero-argument call like pause() cannot reveal,
    // so this test uses one that takes arguments.
    const client = stubClient();
    await executor(client).submit({
      plan: submitPlan({
        call: { functionName: 'release', args: ['0xdeadbeef', 42] },
        description: 'release escrow',
      }),
      incident: incident(),
    });

    const config = (client.createWorkflow as ReturnType<typeof vi.fn>).mock.calls[0][0].nodes[1]
      .data.config;
    expect(config.functionArgs).toBe('["0xdeadbeef",42]');
    expect(config.args).toBeUndefined();
  });

  it('creates the workflow already enabled, in one round trip', async () => {
    const client = stubClient();
    await executor(client).submit({ plan: pausePlan, incident: incident() });
    expect(client.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(client.patchWorkflow).not.toHaveBeenCalled();
  });

  it('reuses a workflow that already exists rather than piling up duplicates', async () => {
    const name = WorkflowExecutor.workflowName({
      playbookId: 'remediation',
      chainId: CHAIN_IDS.sepolia,
      to: OTHER,
      functionName: 'pause',
    });
    const client = stubClient({ listWorkflows: vi.fn(async () => [{ id: 'wf-existing', name }]) });

    const result = await executor(client).submit({ plan: pausePlan, incident: incident() });
    expect(client.createWorkflow).not.toHaveBeenCalled();
    expect(client.executeWorkflow).toHaveBeenCalledWith('wf-existing', expect.anything());
    expect(result.keeperHubActionId).toBe('exec-1');
  });

  it('looks a workflow up once and then remembers it', async () => {
    const client = stubClient();
    const e = executor(client);
    await e.submit({ plan: pausePlan, incident: incident() });
    await e.submit({ plan: pausePlan, incident: incident() });
    expect(client.listWorkflows).toHaveBeenCalledTimes(1);
    expect(client.createWorkflow).toHaveBeenCalledTimes(1);
  });

  it('refuses a plan that needs a specific nonce', async () => {
    // Workflow actions run through the same sponsored relayer.
    await expect(
      executor(stubClient()).submit({ plan: submitPlan({ nonce: 41 }), incident: incident() }),
    ).rejects.toThrow(/sponsored relayer/i);
  });

  it('fails fast on a failed run instead of polling to the timeout', async () => {
    const getWorkflowExecution = vi.fn(async () => ({
      status: 'error',
      error: 'Missing `abiFunction` in the step config',
      logs: [],
    }));
    await expect(
      executor(stubClient({ getWorkflowExecution })).submit({
        plan: pausePlan,
        incident: incident(),
      }),
    ).rejects.toThrow(/abiFunction/);
    expect(getWorkflowExecution).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while the run is still going', async () => {
    const getWorkflowExecution = vi
      .fn()
      .mockResolvedValueOnce({ status: 'running', error: null, logs: [] })
      .mockResolvedValueOnce({
        status: 'success',
        error: null,
        logs: [{ nodeType: 'web3/write-contract', status: 'success', output: { transactionHash: TX } }],
      });
    const result = await executor(stubClient({ getWorkflowExecution })).submit({
      plan: pausePlan,
      incident: incident(),
    });
    expect(result.txHash).toBe(TX);
  });

  it('refuses to report a remediation when the run yields no hash', async () => {
    const getWorkflowExecution = vi.fn(async () => ({ status: 'running', error: null, logs: [] }));
    await expect(
      executor(stubClient({ getWorkflowExecution })).submit({
        plan: pausePlan,
        incident: incident(),
      }),
    ).rejects.toThrow(/no transaction hash/i);
  });

  it('builds a transfer node for a value-only plan', async () => {
    const client = stubClient();
    await executor(client).submit({
      plan: submitPlan({ value: 1_000_000n, description: 'top up the signer' }),
      incident: incident(),
    });
    const nodes = (client.createWorkflow as ReturnType<typeof vi.fn>).mock.calls[0][0].nodes;
    expect(nodes[1].data.config.actionType).toBe('web3/transfer-funds');
    expect(nodes[1].data.config.amount).toBe('1000000');
  });

  it('names a workflow after the work, not the incident', () => {
    const a = WorkflowExecutor.workflowName({ playbookId: 'P4', chainId: 1, to: '0xAbC', functionName: 'pause' });
    const b = WorkflowExecutor.workflowName({ playbookId: 'P4', chainId: 1, to: '0xabc', functionName: 'pause' });
    // Otherwise every incident leaves another workflow in the dashboard.
    expect(a).toBe(b);
  });
});

describe('RoutingExecutor with workflows', () => {
  const workflow = { submit: vi.fn(), verify: vi.fn() };
  const kh = { submit: vi.fn(), verify: vi.fn() };
  const signer = { submit: vi.fn(), verify: vi.fn(), holdsKeyFor: () => true };

  it('prefers a workflow over direct execution when no nonce is needed', () => {
    const router = new RoutingExecutor({ workflow, keeperHub: kh, signer });
    expect(router.route(submitPlan(), incident())).toBe(workflow);
  });

  it('still sends a nonce-precise plan to the key holder', () => {
    const router = new RoutingExecutor({ workflow, keeperHub: kh, signer });
    expect(router.route(submitPlan({ nonce: 41 }), incident())).toBe(signer);
  });

  it('falls back to direct execution when no workflow client exists', () => {
    const router = new RoutingExecutor({ keeperHub: kh, signer });
    expect(router.route(submitPlan(), incident())).toBe(kh);
  });
});

describe('following the documented safe execution sequence', () => {
  const withSim = (over: Partial<KeeperHubSubmitter> = {}): KeeperHubSubmitter => ({
    transfer: vi.fn(async () => ({ executionId: 'exec-1', transactionHash: TX })),
    writeContract: vi.fn(async () => ({ executionId: 'exec-2', transactionHash: TX })),
    simulate: vi.fn(async () => ({ success: true, wouldRevert: false })),
    ...over,
  });

  it('pre-flights before broadcasting, with the same body it will send', async () => {
    const client = withSim();
    const executor = new KeeperHubExecutor(client, verifier());
    await executor.submit({
      plan: submitPlan({ call: { functionName: 'pause', args: [] } }),
      incident: incident(),
    });

    const [path, body] = (client.simulate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/execute/contract-call');
    expect(body).toMatchObject({ contractAddress: OTHER, functionName: 'pause' });
    expect(client.writeContract).toHaveBeenCalled();
  });

  it('does not broadcast when the pre-flight says it would revert', async () => {
    // Gas spent on a remediation that cannot work is worse than no remediation.
    const client = withSim({
      simulate: vi.fn(async () => ({ success: true, wouldRevert: true, detail: 'NotOwner()' })),
    });
    const executor = new KeeperHubExecutor(client, verifier());

    await expect(
      executor.submit({ plan: submitPlan(), incident: incident() }),
    ).rejects.toThrow(/would fail, so it was not broadcast[\s\S]*NotOwner/);
    expect(client.transfer).not.toHaveBeenCalled();
  });

  it('sends an idempotency key that identifies the work, not the attempt', async () => {
    // A reconstructed retry has no memory of a random key, so it must derive
    // the same one or it spends twice.
    const client = withSim();
    const executor = new KeeperHubExecutor(client, verifier());
    const plan = submitPlan({ description: 'fill missing nonce 47' });

    await executor.submit({ plan, incident: incident() });
    await executor.submit({ plan, incident: incident() });

    const calls = (client.transfer as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
    expect(calls[0][0].idempotencyKey).toContain('inc-1');
  });

  it('still works against a client that cannot simulate', async () => {
    const client = withSim({ simulate: undefined });
    const executor = new KeeperHubExecutor(client, verifier());
    await expect(
      executor.submit({ plan: submitPlan(), incident: incident() }),
    ).resolves.toMatchObject({ txHash: TX });
  });
});

describe('KeeperHub workflow validation', () => {
  const stub = (over = {}) => ({
    listWorkflows: vi.fn(async () => []),
    createWorkflow: vi.fn(async () => ({ id: 'wf-1' })),
    patchWorkflow: vi.fn(async () => {}),
    executeWorkflow: vi.fn(async () => ({ executionId: 'exec-1' })),
    getWorkflowExecution: vi.fn(async () => ({
      status: 'success',
      error: null,
      logs: [{ nodeType: 'web3/write-contract', status: 'success', output: { transactionHash: TX } }],
    })),
    ...over,
  });

  const pausePlan = submitPlan({ call: { functionName: 'pause', args: [] } });

  it('checks the workflow before running it, and records the verdict', async () => {
    // Recorded rather than logged: "we asked their validator" is a claim an
    // operator should be able to see on the attempt, not take on trust.
    const validator = { validateWorkflow: vi.fn(async () => ({ valid: true, detail: 'ok' })) };
    const client = stub();
    const result = await new WorkflowExecutor(client, verifier(), {
      sleep: async () => {},
      validator,
    }).submit({ plan: pausePlan, incident: incident() });
    expect(validator.validateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(result.validation).toEqual({ valid: true, detail: 'ok', knownFalsePositive: false });
  });

  it('marks the templated-chain complaint as the known false positive', async () => {
    // KeeperHub#1995, found and fixed by us. Marked rather than hidden, because
    // silently discounting a validator is how a real complaint gets missed.
    const validator = {
      validateWorkflow: vi.fn(async () => ({
        valid: false,
        detail: 'unknown-chain-id: nodes[1].config.network "{{@trigger-1:Manual.network}}"',
      })),
    };
    const result = await new WorkflowExecutor(stub(), verifier(), {
      sleep: async () => {},
      validator,
    }).submit({ plan: pausePlan, incident: incident() });
    expect(result.validation).toMatchObject({ valid: false, knownFalsePositive: true });
  });

  it('does not excuse a genuine complaint as that false positive', async () => {
    const validator = {
      validateWorkflow: vi.fn(async () => ({
        valid: false,
        detail: 'unknown-chain-id: nodes[1].config.network "9999" is not enabled',
      })),
    };
    const result = await new WorkflowExecutor(stub(), verifier(), {
      sleep: async () => {},
      validator,
    }).submit({ plan: pausePlan, incident: incident() });
    expect(result.validation).toMatchObject({ valid: false, knownFalsePositive: false });
  });

  it('records a validator that could not be reached, rather than pretending it passed', async () => {
    const validator = {
      validateWorkflow: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    };
    const result = await new WorkflowExecutor(stub(), verifier(), {
      sleep: async () => {},
      validator,
    }).submit({ plan: pausePlan, incident: incident() });
    expect(result.validation).toMatchObject({ valid: false, knownFalsePositive: false });
    expect(result.validation?.detail).toMatch(/unavailable/);
    // Still ran: an incident does not wait on a validator being up.
    expect(result.txHash).toBe(TX);
  });

  it('still runs when validation says the workflow is invalid', async () => {
    // Their validator reports a templated `network` as an unknown chain id, and
    // our live marketplace workflow fails validation while executing correctly
    // and settling real payments. Blocking on the verdict would break working
    // remediations.
    const logged: unknown[] = [];
    const validator = {
      validateWorkflow: vi.fn(async () => ({
        valid: false,
        detail: 'unknown-chain-id: nodes[1].config.network is not a numeric chain ID string',
      })),
    };
    const result = await new WorkflowExecutor(stub(), verifier(), {
      sleep: async () => {},
      validator,
      logger: { info: (_m, d) => logged.push(d), error: () => {} },
    }).submit({ plan: pausePlan, incident: incident() });

    expect(result.txHash).toBe(TX);
    expect(JSON.stringify(logged)).toContain('unknown-chain-id');
  });

  it('runs when the validator is unreachable', async () => {
    const validator = {
      validateWorkflow: vi.fn(async () => {
        throw new Error('MCP session refused');
      }),
    };
    await expect(
      new WorkflowExecutor(stub(), verifier(), {
        sleep: async () => {},
        validator,
        logger: { info: () => {}, error: () => {} },
      }).submit({ plan: pausePlan, incident: incident() }),
    ).resolves.toMatchObject({ txHash: TX });
  });

  it('does not call a validator that was not configured', async () => {
    const client = stub();
    await expect(
      new WorkflowExecutor(client, verifier(), { sleep: async () => {} }).submit({
        plan: pausePlan,
        incident: incident(),
      }),
    ).resolves.toMatchObject({ txHash: TX });
  });
});
