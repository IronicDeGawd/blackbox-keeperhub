#!/usr/bin/env node
// Mock Blackbox API. Zero dependencies — `node tools/mock-api.mjs` and build against it.
//
// Serves the exact route shapes and payloads the real Fastify server will, so
// UI written against this keeps working when it is swapped out. The only
// differences are that the data is synthetic and the chaos endpoints do not
// touch a chain.
//
//   PORT=4001 node tools/mock-api.mjs
//
// Every response is CORS-open, because the console runs on a different port in
// development.

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4001);
const CHAIN_ID = 11155111;
const CHAIN_NAME = 'Ethereum Sepolia';
const explorer = (h) => `https://sepolia.etherscan.io/tx/${h}`;

// ---------------------------------------------------------------------------
// Fixtures. Hashes are real Sepolia transactions from live runs, so explorer
// links in the UI actually resolve.
// ---------------------------------------------------------------------------

const AGENT = 'chaos';
const SIGNER = '0xb9c58185d09D0aCf3b237cD45C67345E32e628BA';
const now = () => new Date().toISOString();
const ago = (ms) => new Date(Date.now() - ms).toISOString();

let seq = 100;
const nextId = (p) => `${p}-${seq++}`;

const incidents = new Map();

function makeIncident(over = {}) {
  const id = over.id ?? nextId('inc');
  const incident = {
    id,
    class: 'NONCE_GAP',
    severity: 'critical',
    status: 'open',
    agentId: AGENT,
    signer: SIGNER,
    chainId: CHAIN_ID,
    summary: 'Nonce 47 unfilled; 1 action blocked behind it',
    detectedAt: ago(120_000),
    firstEventAt: ago(180_000),
    lastSeenAt: ago(20_000),
    resolvedAt: null,
    resolvedBy: null,
    confidence: 0.9,
    evidence: {
      ruleId: 'R2',
      eventIds: ['evt-1', 'evt-2'],
      facts: {
        latestNonce: 47,
        pendingNonce: 47,
        highestSubmittedNonce: 48,
        missingNonces: [47],
        gap: 1,
        blockedActionCount: 1,
        consecutiveGapPolls: 2,
        nonceGapConfirmations: 2,
      },
      corroboration: {
        latestNonce: 47,
        pendingNonce: 47,
        signerBalance: '63813361787234000',
        baseFeeAtDetection: '1204512',
      },
      suppressedRules: [],
    },
    rca: null,
    remediation: null,
    ...over,
  };
  incidents.set(id, incident);
  return incident;
}

const RCA_SAMPLE = {
  // Field names match packages/core/src/schemas.ts rootCauseAnalysisSchema.
  summary:
    'A transaction was submitted at nonce 48 while nonce 47 was never used. ' +
    'Ethereum executes an account\'s transactions strictly in order, so nothing ' +
    'at 48 or above can be mined until 47 is filled. One queued action is ' +
    'blocked behind the hole.',
  contributingFactors: [
    'A submission at nonce 47 was prepared but never broadcast',
    'No nonce reconciliation runs between submissions',
  ],
  recommendation:
    'Read the pending nonce immediately before signing, and reconcile the ' +
    'submitted set against the chain after every batch.',
  timeline: [{ at: ago(180_000), what: 'First related execution observed' }],
  model: 'gemini-3.5-flash-lite',
  generatedAt: ago(90_000),
  promptVersion: '2026-08-10.3',
};

const REMEDIATION_SAMPLE = {
  playbookId: 'P2',
  playbookName: 'Nonce gap clear',
  finalStatus: 'succeeded',
  verifiedAt: ago(30_000),
  attempts: [
    {
      attemptIndex: 0,
      startedAt: ago(45_000),
      completedAt: ago(30_000),
      status: 'succeeded',
      guardsPassed: [
        'dry_run',
        'min_confidence',
        'signer_allowlist',
        'chain_allowlist',
        'budget',
        'no_remediation_in_flight',
        'max_attempts',
        'not_self',
      ],
      guardsFailed: [],
      txHash: '0x68a38ff18521775f812e27e5dd678d7ba6659b2ae3e086325c85a9d1fd88d925',
      explorerUrl: explorer('0x68a38ff18521775f812e27e5dd678d7ba6659b2ae3e086325c85a9d1fd88d925'),
      gasUsed: '21000',
      route: 'public',
      executor: 'keeperhub-workflow',
      description: 'fill missing nonce 47',
    },
  ],
};

const SKIPPED_REMEDIATION = {
  playbookId: 'P3',
  playbookName: 'Private reroute',
  finalStatus: 'skipped_by_policy',
  verifiedAt: null,
  attempts: [
    {
      attemptIndex: 0,
      startedAt: ago(60_000),
      completedAt: ago(60_000),
      status: 'skipped',
      guardsPassed: ['dry_run', 'min_confidence', 'signer_allowlist', 'chain_allowlist'],
      guardsFailed: [],
      failureReason:
        'Base Sepolia has no private mempool, so there is no alternative route to submit through',
    },
  ],
};

// Seed a spread that exercises every visual state the UI has to handle.
makeIncident({
  id: 'inc-1',
  status: 'resolved',
  resolvedAt: ago(25_000),
  resolvedBy: 'blackbox',
  rca: RCA_SAMPLE,
  remediation: REMEDIATION_SAMPLE,
  summary: 'Nonce 47 unfilled; cleared by Blackbox',
});
makeIncident({ id: 'inc-2', status: 'open' });
makeIncident({
  id: 'inc-3',
  class: 'STUCK_TRANSACTION',
  severity: 'warning',
  status: 'diagnosing',
  confidence: 0.95,
  summary: 'Transaction pending 4m12s at nonce 51',
  evidence: {
    ruleId: 'R1',
    eventIds: ['evt-9'],
    facts: {
      nonce: 51,
      txHash: '0xcc22eede6cd6cac9c3fa515204b65b59f823a4ccb6ff6e3b848ebffa73264d5c',
      submittedMaxFeePerGas: '1500000000',
      currentBaseFee: '2400000',
      pendingDurationMs: 252_000,
      stuckThresholdMs: 90_000,
      corroborated: true,
    },
    corroboration: { latestNonce: 51, baseFeeAtDetection: '2400000' },
    suppressedRules: [],
  },
});
makeIncident({
  id: 'inc-4',
  class: 'ADVERSE_INCLUSION',
  severity: 'warning',
  status: 'open',
  chainId: 84532,
  confidence: 0.7,
  summary: 'Swap executed 4.1% worse than quoted',
  remediation: SKIPPED_REMEDIATION,
  evidence: {
    ruleId: 'R7',
    eventIds: ['evt-12'],
    facts: {
      expectedOut: '1000000000000000000',
      actualOut: '959000000000000000',
      deltaBps: 410,
      slippageToleranceBps: 100,
      blockNumber: 11457999,
      txIndexInBlock: 42,
      neighbouringTxHashes: ['0xaaa…', '0xbbb…'],
      route: 'public',
    },
    corroboration: {},
    suppressedRules: [],
  },
});
makeIncident({
  id: 'inc-5',
  class: 'SIGNER_GAS_STARVED',
  severity: 'critical',
  status: 'remediating',
  confidence: 0.99,
  summary: 'Balance covers under 1 further action',
  evidence: {
    ruleId: 'R6',
    eventIds: ['evt-15'],
    facts: {
      signerBalance: '38886020810000',
      medianRecentCost: '43819765332000',
      gasStarvedMultiple: 3,
      thresholdBalance: '131459295996000',
      projectedActionsRemaining: 0,
      observedFundingFailure: false,
    },
    corroboration: { signerBalance: '900000000000000' },
    suppressedRules: [],
  },
});

const EVENTS = {
  'inc-1': [
    { id: 'evt-1', at: ago(180_000), kind: 'submission', label: 'Submitted at nonce 48', txHash: '0xcc22eede6cd6cac9c3fa515204b65b59f823a4ccb6ff6e3b848ebffa73264d5c', blockNumber: null, status: 'pending' },
    { id: 'evt-2', at: ago(120_000), kind: 'detection', label: 'R2 fired — NONCE_GAP', txHash: null, blockNumber: null, status: 'open' },
    { id: 'evt-3', at: ago(90_000), kind: 'rca', label: 'Root cause analysis generated', txHash: null, blockNumber: null, status: 'diagnosing' },
    { id: 'evt-4', at: ago(45_000), kind: 'remediation', label: 'P2 submitted at nonce 47', txHash: '0x68a38ff18521775f812e27e5dd678d7ba6659b2ae3e086325c85a9d1fd88d925', blockNumber: null, status: 'remediating' },
    { id: 'evt-5', at: ago(30_000), kind: 'inclusion', label: 'Remediation included', txHash: '0x68a38ff18521775f812e27e5dd678d7ba6659b2ae3e086325c85a9d1fd88d925', blockNumber: 11453998, status: 'resolved' },
  ],
};

const SCENARIOS = [
  { id: 'C1', name: 'Underpriced submission', induces: ['GAS_UNDERPRICED', 'STUCK_TRANSACTION'], enabled: true, deterministic: false, note: 'Bids at the base fee with no tip; depends on network conditions.' },
  { id: 'C2', name: 'Nonce gap', induces: ['NONCE_GAP'], enabled: true, deterministic: true, note: 'The reliable one. Detection within two polls.' },
  { id: 'C3', name: 'Simulation passes, execution reverts', induces: ['SIM_PASS_EXEC_REVERT'], enabled: true, deterministic: true, note: 'Arms a trap on ChaosTarget that springs one block later.' },
  { id: 'C4', name: 'Retry storm', induces: ['RETRY_STORM'], enabled: true, deterministic: true, note: 'Points a retrying action at an unconditional revert.' },
  { id: 'C5', name: 'Signer gas starvation', induces: ['SIGNER_GAS_STARVED'], enabled: true, deterministic: true, note: 'Sweeps the chaos signer below one action of runway.' },
  { id: 'C6', name: 'Adverse inclusion', induces: ['ADVERSE_INCLUSION'], enabled: false, deterministic: false, note: 'Needs controllable ordering; local fork only.' },
];

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

let watched = [
  {
    signer: '0xb9c58185d09d0acf3b237cd45c67345e32e628ba',
    chainId: CHAIN_ID,
    agentId: AGENT,
    label: 'chaos signer',
    registeredAt: ago(600_000),
  },
];

const clients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

const summariesOf = (list) => list.map(summary);

function summary(i) {
  return {
    id: i.id,
    class: i.class,
    severity: i.severity,
    status: i.status,
    agentId: i.agentId,
    signer: i.signer,
    chainId: i.chainId,
    summary: i.summary,
    detectedAt: i.detectedAt,
    lastSeenAt: i.lastSeenAt,
    resolvedAt: i.resolvedAt,
    resolvedBy: i.resolvedBy,
    confidence: i.confidence,
    ruleId: i.evidence.ruleId,
    hasRca: Boolean(i.rca),
    remediationStatus: i.remediation?.finalStatus ?? null,
    remediationTxHash: i.remediation?.attempts?.find((a) => a.txHash)?.txHash ?? null,
  };
}

function stats() {
  const all = [...incidents.values()];
  const open = all.filter((i) => !['resolved', 'acknowledged'].includes(i.status));
  const remediations = all.flatMap((i) => i.remediation?.attempts ?? []);
  const succeeded = remediations.filter((a) => a.status === 'succeeded');
  return {
    incidentsDetected: all.length,
    openBySeverity: {
      critical: open.filter((i) => i.severity === 'critical').length,
      warning: open.filter((i) => i.severity === 'warning').length,
      info: open.filter((i) => i.severity === 'info').length,
    },
    remediations: {
      total: remediations.length,
      succeeded: succeeded.length,
      skipped: remediations.filter((a) => a.status === 'skipped').length,
      failed: remediations.filter((a) => a.status === 'failed').length,
      gasWei: succeeded.reduce((s, a) => s + BigInt(a.gasUsed ?? 0), 0n).toString(),
    },
    meanTimeToDetectionMs: 41_000,
    meanTimeToRemediationMs: 63_000,
    updatedAt: now(),
  };
}

// A slow drip so the timeline visibly lives. Advances one incident through the
// lifecycle every few seconds and emits the matching events.
const LIFECYCLE = ['open', 'diagnosing', 'remediating', 'resolved'];
setInterval(() => {
  const movable = [...incidents.values()].filter((i) => i.status !== 'resolved');
  const target = movable[Math.floor(Math.random() * movable.length)];
  if (!target) return;
  const next = LIFECYCLE[Math.min(LIFECYCLE.indexOf(target.status) + 1, LIFECYCLE.length - 1)];
  target.status = next;
  target.lastSeenAt = now();
  if (next === 'diagnosing' && !target.rca) target.rca = { ...RCA_SAMPLE, generatedAt: now() };
  if (next === 'remediating' && !target.remediation) {
    target.remediation = { ...REMEDIATION_SAMPLE, finalStatus: 'pending', verifiedAt: null };
    broadcast('remediation.started', { incidentId: target.id, playbookId: 'P2' });
  }
  if (next === 'resolved') {
    target.resolvedAt = now();
    target.resolvedBy = 'blackbox';
    target.remediation = REMEDIATION_SAMPLE;
    broadcast('remediation.succeeded', {
      incidentId: target.id,
      txHash: REMEDIATION_SAMPLE.attempts[0].txHash,
      explorerUrl: REMEDIATION_SAMPLE.attempts[0].explorerUrl,
    });
  }
  broadcast('incident.updated', summary(target));
  broadcast('stats.updated', stats());
}, 6000).unref?.();

// The scanner keeping up with head. A quiet liveness signal: without it, "no
// incidents" and "nothing is running" look identical.
let head = 11458000;
setInterval(() => {
  head += 1;
  broadcast('scan.progress', {
    fromBlock: head,
    toBlock: head,
    blocksScanned: 1,
    matched: 0,
    watching: watched.length,
  });
}, 12_000).unref?.();

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const json = (res, status, body) => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(payload);
};

const notFound = (res, detail) =>
  json(res, 404, { error: 'not_found', detail, requestId: nextId('req') });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const q = url.searchParams;

  if (req.method === 'OPTIONS') return json(res, 204, {});

  // GET /api/stream — SSE. Every mutation is announced here.
  if (path === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ at: now(), chainId: CHAIN_ID })}\n\n`);
    res.write(`event: stats.updated\ndata: ${JSON.stringify(stats())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (path === '/api/health') return json(res, 200, { ok: true, mock: true, at: now() });

  // --- watched addresses ----------------------------------------------------
  if (path === '/api/watched' && req.method === 'GET') {
    return json(res, 200, { items: watched });
  }

  if (path === '/api/watched' && req.method === 'POST') {
    const body = await readBody(req);
    const signer = String(body.signer ?? '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(signer)) {
      return json(res, 400, {
        error: 'invalid_address',
        detail: `"${signer}" is not a 20-byte hex address`,
        requestId: nextId('req'),
      });
    }
    const chainId = Number(body.chainId ?? CHAIN_ID);
    if (![11155111, 84532, 1, 8453].includes(chainId)) {
      return json(res, 400, {
        error: 'unsupported_chain',
        detail: `Chain ${chainId} is not configured`,
        requestId: nextId('req'),
      });
    }
    const entry = {
      signer: signer.toLowerCase(),
      chainId,
      agentId: String(body.agentId ?? signer.slice(0, 10)),
      label: body.label ?? null,
      registeredAt: now(),
    };
    watched = watched.filter((w) => w.signer !== entry.signer).concat(entry);
    return json(res, 201, { signer: entry.signer, chainId, watching: true });
  }

  const unwatch = path.match(/^\/api\/watched\/([^/]+)$/);
  if (unwatch && req.method === 'DELETE') {
    watched = watched.filter((w) => w.signer !== unwatch[1].toLowerCase());
    return json(res, 200, { signer: unwatch[1].toLowerCase(), watching: false });
  }

  // --- explain any transaction ----------------------------------------------
  if (path === '/api/diagnose' && req.method === 'POST') {
    const body = await readBody(req);
    const txHash = String(body.txHash ?? '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return json(res, 400, {
        error: 'invalid_tx_hash',
        detail: `"${txHash}" is not a 32-byte transaction hash`,
        requestId: nextId('req'),
      });
    }
    // Three shapes, chosen by the last hex digit so a UI can exercise each on
    // demand: 0 not found, 1 nothing wrong, anything else classified.
    const last = txHash.slice(-1);
    if (last === '0') {
      return json(res, 200, {
        txHash,
        chainId: CHAIN_ID,
        found: false,
        detail: 'No such transaction on this chain, or it is not yet visible to this node.',
      });
    }
    if (last === '1') {
      return json(res, 200, {
        txHash, chainId: CHAIN_ID, chain: CHAIN_NAME, found: true,
        signer: SIGNER, nonce: 93, status: 'included', blockNumber: 11457999,
        simulation: { performed: false, success: null, simulatedAtBlock: null,
          note: 'Not replayed: only a reverted transaction is worth replaying.' },
        explorerUrl: explorer(txHash),
        class: null,
        detail: 'No rule fired for this transaction.',
        checked: { latestNonce: 94, pendingNonce: 94, missingNonces: [], balanceWei: '61698676197118630' },
      });
    }
    return json(res, 200, {
      txHash, chainId: CHAIN_ID, chain: CHAIN_NAME, found: true,
      signer: SIGNER, nonce: 42, status: 'reverted', blockNumber: 11457536,
      simulation: { performed: true, success: true, simulatedAtBlock: 11457535,
        note: 'Replayed against the block before inclusion to establish whether state drifted.' },
      explorerUrl: explorer(txHash),
      class: 'SIM_PASS_EXEC_REVERT',
      severity: 'critical',
      confidence: 0.95,
      ruleId: 'R4',
      facts: { blockDrift: 1, simulatedAtBlock: 11457535, includedAtBlock: 11457536, gasUsed: '33245' },
      rca: { ...RCA_SAMPLE,
        summary: 'The call simulated clean at block 11457535 and reverted at 11457536. Nothing about the call changed; the state underneath it did.',
        contributingFactors: ['State the call depends on was modified between simulation and inclusion'],
        recommendation: 'Re-simulate immediately before submission and make the call defend its own preconditions on chain.',
        timeline: [] },
      rcaSource: 'model',
    });
  }

  if (path === '/api/stats') return json(res, 200, stats());

  // A quarter of the day's budget gone: enough to render, not enough to warn.
  if (path === '/api/connections/keeperhub/spend') {
    return json(res, 200, {
      capWei: '1000000000000000000',
      usedWei: '250000000000000000',
      ratio: 0.25,
      uncapped: false,
    });
  }

  // Intact, so the console's quiet state is the one being built against.
  if (path === '/api/ledger/verify') {
    return json(res, 200, {
      ok: true,
      entries: 3,
      unchained: 0,
      brokenAt: null,
      reason: 'ok',
      checkedAt: new Date().toISOString(),
    });
  }

  if (path === '/api/config') {
    return json(res, 200, {
      chains: [
        { chainId: 11155111, name: 'Ethereum Sepolia', testnet: true, privateMempool: true, explorerTxUrl: 'https://sepolia.etherscan.io/tx/{hash}' },
        { chainId: 84532, name: 'Base Sepolia', testnet: true, privateMempool: false, explorerTxUrl: 'https://sepolia.basescan.org/tx/{hash}' },
      ],
      remediation: {
        dryRun: false,
        minConfidence: 0.8,
        maxAttempts: 3,
        signerAllowlist: [SIGNER],
        chainAllowlist: [11155111],
        budget: { maxRemediationsPerHour: 10, maxGasWeiPerHour: '50000000000000000' },
      },
      capabilities: {
        remediate: true,
        chaos: true,
        diagnose: true,
        signerHealth: true,
        proposeRemediation: true,
      },
      version: '0.1.0-mock',
    });
  }

  if (path === '/api/incidents' && req.method === 'GET') {
    let items = [...incidents.values()];
    if (q.get('status')) items = items.filter((i) => i.status === q.get('status'));
    if (q.get('class')) items = items.filter((i) => i.class === q.get('class'));
    if (q.get('severity')) items = items.filter((i) => i.severity === q.get('severity'));
    if (q.get('agentId')) items = items.filter((i) => i.agentId === q.get('agentId'));
    if (q.get('signer')) items = items.filter((i) => i.signer.toLowerCase() === q.get('signer').toLowerCase());
    if (q.get('chainId')) items = items.filter((i) => String(i.chainId) === q.get('chainId'));
    items.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    const limit = Number(q.get('limit') ?? 50);
    return json(res, 200, {
      items: summariesOf(items.slice(0, limit)),
      nextCursor: items.length > limit ? items[limit].id : null,
      total: items.length,
    });
  }

  const detail = path.match(/^\/api\/incidents\/([^/]+)$/);
  if (detail && req.method === 'GET') {
    const incident = incidents.get(detail[1]);
    if (!incident) return notFound(res, `Incident ${detail[1]} not found`);
    return json(res, 200, {
      ...incident,
      events: EVENTS[incident.id] ?? [],
      explorerUrls: (incident.remediation?.attempts ?? [])
        .filter((a) => a.txHash)
        .map((a) => explorer(a.txHash)),
    });
  }

  // The per-node record of the runs behind an incident. Live, this needs the
  // operator's own connection; here it is just enough shape to build against.
  const runLog = path.match(/^\/api\/incidents\/([^/]+)\/run-log$/);
  if (runLog && req.method === 'GET') {
    const incident = incidents.get(runLog[1]);
    if (!incident) return notFound(res, `Incident ${runLog[1]} not found`);
    return json(res, 200, {
      incidentId: incident.id,
      runs: [
        {
          executionId: `exec-${incident.id}`,
          status: 'failed',
          error: 'execution reverted: transfer amount exceeds balance',
          steps: [
            {
              nodeId: 'trigger',
              nodeType: 'schedule',
              status: 'success',
              txHash: null,
              gasUsed: null,
              sponsored: null,
            },
            {
              nodeId: 'check-balance',
              nodeType: 'contract-read',
              status: 'success',
              txHash: null,
              gasUsed: null,
              sponsored: null,
            },
            {
              nodeId: 'send',
              nodeType: 'contract-call',
              status: 'failed',
              txHash: null,
              gasUsed: null,
              sponsored: null,
            },
          ],
        },
      ],
    });
  }

  const ack = path.match(/^\/api\/incidents\/([^/]+)\/acknowledge$/);
  if (ack && req.method === 'POST') {
    const incident = incidents.get(ack[1]);
    if (!incident) return notFound(res, `Incident ${ack[1]} not found`);
    incident.status = 'acknowledged';
    broadcast('incident.updated', summary(incident));
    return json(res, 200, summary(incident));
  }

  const remediate = path.match(/^\/api\/incidents\/([^/]+)\/remediate$/);
  if (remediate && req.method === 'POST') {
    const incident = incidents.get(remediate[1]);
    if (!incident) return notFound(res, `Incident ${remediate[1]} not found`);
    // Guard refusals are a first-class response, not an error: the UI has to
    // render "Blackbox declined, and here is why" as prominently as a success.
    if (incident.chainId === 84532) {
      return json(res, 200, {
        accepted: false,
        incidentId: incident.id,
        playbookId: 'P3',
        finalStatus: 'skipped_by_guard',
        guardsFailed: [
          { guard: 'chain_allowlist', reason: 'chain 84532 is not on the allowlist' },
        ],
      });
    }
    incident.status = 'remediating';
    broadcast('incident.updated', summary(incident));
    broadcast('remediation.started', { incidentId: incident.id, playbookId: 'P2' });
    setTimeout(() => {
      incident.status = 'resolved';
      incident.resolvedAt = now();
      incident.resolvedBy = 'blackbox';
      incident.remediation = REMEDIATION_SAMPLE;
      broadcast('incident.updated', summary(incident));
      broadcast('remediation.succeeded', {
        incidentId: incident.id,
        txHash: REMEDIATION_SAMPLE.attempts[0].txHash,
        explorerUrl: REMEDIATION_SAMPLE.attempts[0].explorerUrl,
      });
    }, 4000);
    return json(res, 202, {
      accepted: true,
      incidentId: incident.id,
      playbookId: 'P2',
      attemptId: nextId('rem'),
    });
  }

  const plan = path.match(/^\/api\/incidents\/([^/]+)\/remediation-plan$/);
  if (plan && req.method === 'GET') {
    const incident = incidents.get(plan[1]);
    if (!incident) return notFound(res, `Incident ${plan[1]} not found`);
    if (incident.chainId === 84532) {
      return json(res, 200, {
        incidentId: incident.id, playbookId: 'P3', actionable: false,
        signerRequired: incident.signer, chainId: incident.chainId,
        guards: { passed: ['min_confidence'], failed: [] },
        transaction: null,
        declined: { policy: 'skipped_by_policy',
          reason: 'Base Sepolia has no private mempool, so there is no alternative route to submit through' },
      });
    }
    return json(res, 200, {
      incidentId: incident.id,
      playbookId: 'P2',
      actionable: true,
      signerRequired: incident.signer,
      chainId: incident.chainId,
      guards: {
        passed: ['min_confidence', 'signer_allowlist', 'chain_allowlist', 'not_self', 'budget'],
        failed: [],
      },
      transaction: {
        to: incident.signer,
        value: '0',
        data: null,
        nonce: 47,
        maxFeePerGas: '4191302983',
        maxPriorityFeePerGas: '2000000000',
        chainId: incident.chainId,
        description: 'fill missing nonce 47',
        route: 'private',
      },
      declined: null,
    });
  }

  const userTx = path.match(/^\/api\/incidents\/([^/]+)\/remediation-tx$/);
  if (userTx && req.method === 'POST') {
    const incident = incidents.get(userTx[1]);
    if (!incident) return notFound(res, `Incident ${userTx[1]} not found`);
    const body = await readBody(req);
    const txHash = String(body.txHash ?? '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return json(res, 400, { error: 'invalid_tx_hash', detail: `"${txHash}" is not a 32-byte transaction hash`, requestId: nextId('req') });
    }
    // Ending in 9 stands for "signed by the wrong account", so the rejection
    // path can be built without a wallet.
    if (txHash.endsWith('9')) {
      return json(res, 422, {
        error: 'transaction_rejected',
        detail: `That transaction was sent by 0xa17cb6adb58277e5b4a44b8c1ecb449bb6614e87, but this incident is about ${incident.signer}. Only a transaction from the incident's own signer can resolve it.`,
        requestId: nextId('req'),
      });
    }
    incident.status = 'resolved';
    incident.resolvedAt = now();
    incident.resolvedBy = 'blackbox-proposed';
    incident.remediation = {
      ...REMEDIATION_SAMPLE,
      attempts: [{ ...REMEDIATION_SAMPLE.attempts[0], txHash, explorerUrl: explorer(txHash), executor: 'user-signed' }],
    };
    broadcast('incident.updated', summary(incident));
    broadcast('remediation.succeeded', { incidentId: incident.id, txHash, explorerUrl: explorer(txHash) });
    return json(res, 200, { accepted: true, included: true, gasUsed: '21000', explorerUrl: explorer(txHash) });
  }

  const health = path.match(/^\/api\/signers\/([^/]+)\/health$/);
  if (health) {
    return json(res, 200, {
      signer: health[1],
      chainId: Number(q.get('chainId') ?? CHAIN_ID),
      balanceWei: '63813361787234000',
      latestNonce: 49,
      pendingNonce: 49,
      missingNonces: [],
      // The signer-health route does expose runwayActions; the rule's own fact
      // is projectedActionsRemaining. They are different fields on different
      // shapes — do not conflate them.
      runwayActions: 42,
      openIncidents: summariesOf([...incidents.values()].filter((i) => i.status === 'open')),
      recentFailureRate: 0.12,
      windowMinutes: 60,
    });
  }

  if (path === '/api/agents') {
    return json(res, 200, {
      items: [
        { agentId: AGENT, label: 'Chaos harness', signers: [SIGNER], chainIds: [11155111, 84532], openIncidents: 2 },
        { agentId: 'blackbox', label: 'Blackbox itself', signers: [SIGNER], chainIds: [11155111], openIncidents: 0, selfRemediation: false },
      ],
    });
  }

  if (path === '/api/chaos/scenarios') {
    return json(res, 200, {
      chainId: CHAIN_ID,
      chainName: CHAIN_NAME,
      isTestnet: true,
      signer: SIGNER,
      signerBalanceWei: '63813361787234000',
      targets: {
        chaosTarget: '0x0000000000000000000000000000000000000000',
        circuitBreaker: '0x0000000000000000000000000000000000000000',
      },
      items: SCENARIOS,
    });
  }

  if (path === '/api/chaos/run' && req.method === 'POST') {
    const body = await readBody(req);
    const scenario = SCENARIOS.find((s) => s.id === body.scenario);
    if (!scenario) return notFound(res, `Unknown scenario ${body.scenario}`);
    if (!scenario.enabled) {
      return json(res, 409, {
        error: 'scenario_unavailable',
        detail: scenario.note,
        requestId: nextId('req'),
      });
    }
    const runId = nextId('run');
    broadcast('chaos.started', { runId, scenario: scenario.id, at: now() });
    setTimeout(() => {
      const created = makeIncident({ detectedAt: now(), lastSeenAt: now() });
      broadcast('incident.created', summary(created));
      broadcast('chaos.completed', { runId, scenario: scenario.id, incidentIds: [created.id] });
      broadcast('stats.updated', stats());
    }, 3000);
    return json(res, 202, {
      runId,
      scenario: scenario.id,
      txHashes: ['0xcc22eede6cd6cac9c3fa515204b65b59f823a4ccb6ff6e3b848ebffa73264d5c'],
      expectedIncidentClass: scenario.induces[0],
      expectedDetectionSeconds: 45,
    });
  }

  return notFound(res, `Route ${req.method} ${path} not found`);
});

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// Binding is explicit so this can be put on a tailnet address without also
// appearing on every other interface the machine happens to have.
const HOST = process.env.HOST ?? '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`mock Blackbox API on http://${HOST}:${PORT}`);
  console.log('  GET  /api/incidents            list + filters');
  console.log('  GET  /api/incidents/:id        detail with events');
console.log('  GET  /api/incidents/:id/run-log  per-node log of the runs behind it');
  console.log('  POST /api/incidents/:id/remediate');
  console.log('  GET  /api/stats                header strip');
  console.log('  GET  /api/chaos/scenarios      chaos panel');
  console.log('  POST /api/chaos/run            { "scenario": "C2" }');
  console.log('  GET  /api/stream               SSE, drips lifecycle every 6s');
});
