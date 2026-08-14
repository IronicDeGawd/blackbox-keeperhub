// The KeeperHub remediation path on live Sepolia: C4 burns gas in a retry
// storm, R5 detects it, and P4 pauses the agent's circuit breaker — submitted
// through KeeperHub Direct Execution, not from any key Blackbox holds.
// Verified by reading isPaused() back off the chain.
import { KeeperHubClient } from '../../core/dist/index.js';
import {
  Remediator,
  RemediationLoop,
  RoutingExecutor,
  KeeperHubExecutor,
  ReceiptVerifier,
} from '../../remediator/dist/index.js';
import { encodeFunctionData } from 'viem';
import {
  setup,
  pollUntil,
  printLoopResult,
  printRemediation,
  env,
  CHAIN,
} from './harness.mjs';

const BREAKER = env.CIRCUIT_BREAKER_ADDRESS;
const { account, db, close, pub, rpcUrl, config, harness, recorder, tracker, makeId } = await setup({
  live: true,
});

const IS_PAUSED = [
  { name: 'isPaused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
];
const readPaused = () =>
  pub.readContract({ address: BREAKER, abi: IS_PAUSED, functionName: 'isPaused' });

console.log('breaker     ', BREAKER);
console.log('paused now  ', await readPaused());

// KeeperHub as the submission path. Note what is absent: any private key for
// the breaker's pauser. The managed wallet is the pauser and KeeperHub drives it.
const kh = new KeeperHubClient({ orgKey: env.KEEPERHUB_ORG_KEY });
const PAUSE_ABI = JSON.stringify([
  { name: 'pause', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
]);

const submitter = {
  transfer: async (params) => {
    const execution = await kh.transfer(params);
    return { executionId: execution.executionId, transactionHash: execution.transactionHash ?? undefined };
  },
  // A contract-call submission answers without a hash even once mined, so the
  // executor asks for it by execution id.
  getExecutionStatus: async (id) => {
    const execution = await kh.getExecutionStatus(id);
    return { transactionHash: execution.transactionHash ?? null };
  },
  writeContract: async (params) => {
    console.log('  -> KeeperHub contract-call', JSON.stringify(params));
    const execution = await kh.writeContract({ ...params, abi: params.abi ?? PAUSE_ABI });
    console.log('  <- execution', execution.executionId, execution.status,
      execution.transactionHash ?? '(no hash in the submission response)');
    return { executionId: execution.executionId, transactionHash: execution.transactionHash ?? undefined };
  },
};

const loop = new RemediationLoop({
  db,
  remediator: new Remediator({
    db,
    config,
    executor: new RoutingExecutor({
      keeperHub: new KeeperHubExecutor(submitter, new ReceiptVerifier({ [CHAIN]: rpcUrl })),
    }),
    market: async () => {
      const block = await pub.getBlock({ blockTag: 'latest' });
      return { baseFee: block.baseFeePerGas ?? 1_000_000_000n, suggestedPriorityFee: 1_000_000_000n };
    },
    // The breaker this agent registered. P4 declines with a reason without one.
    // A lookup rather than a map: breakers are registered per agent at runtime,
    // so a connected operator's agent can have one too.
    breakerFor: async (agentId) => (agentId === 'chaos' ? BREAKER : null),
    makeId: makeId('rem'),
    logger: { info: () => {}, error: (m, d) => console.log('  [rem err]', m, d?.error?.message ?? '') },
  }),
  onRemediated: (id, outcome) => tracker.attachRemediation(id, outcome.record),
  logger: { info: () => {}, error: (m, d) => console.log('  [loop err]', m, String(d?.error ?? '').slice(0, 300)) },
});

// --- induce ----------------------------------------------------------------
console.log('\n-- retry storm --');
const result = await harness.c4RetryStorm(4);
console.log('  attempts:', result.txHashes.length, 'action', result.detail.logicalActionId);

// --- detect ----------------------------------------------------------------
console.log('\n-- detection --');
const open = await pollUntil(recorder, db, account, (found) => found.some((i) => i.class === 'RETRY_STORM'), {
  attempts: 6,
  listParams: { status: 'open' },
});
if (open.length === 0) {
  console.log('nothing detected');
  await close();
  process.exit(1);
}

// --- remediate through KeeperHub -------------------------------------------
console.log('\n-- remediation via KeeperHub --');
const tick = await loop.tick();
printLoopResult(tick);
for (const { incidentId, outcome } of tick.outcomes) {
  await printRemediation(pub, incidentId, outcome);
}

// --- verify the agent is actually halted -----------------------------------
console.log('\n-- aftermath --');
console.log('breaker isPaused:', await readPaused());
const workData = encodeFunctionData({
  abi: [{ name: 'work', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] }],
  functionName: 'work',
});
try {
  await pub.call({ account: account.address, to: env.CHAOS_TARGET_ADDRESS, data: workData });
  console.log('work() still simulates clean — the agent is NOT halted');
} catch (error) {
  console.log('work() now reverts:', String(error.message).split('\n')[0].slice(0, 120));
}
console.log('\nunpause with: cast send', BREAKER, '"unpause()" --rpc-url $ALCHEMY_RPC_URL --private-key $CHAOS_SIGNER_PRIVATE_KEY');

await close();
