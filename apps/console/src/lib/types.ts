/**
 * The wire contract, mirroring packages/core/src/schemas.ts and the shapes
 * packages/api/src/serialise.ts puts on them.
 *
 * Two things are deliberate here:
 *
 * - Every wei figure is `string`, never `number`. These values exceed
 *   Number.MAX_SAFE_INTEGER and a JSON number would be silently wrong, so the
 *   type refuses to let one become a number by accident.
 * - Fields that one implementation sends and the other does not are optional
 *   rather than assumed. The mock and the server disagree in three places
 *   (noted below); the console reads whichever is present.
 */

export type IncidentClass =
  | 'STUCK_TRANSACTION'
  | 'NONCE_GAP'
  | 'GAS_UNDERPRICED'
  | 'SIM_PASS_EXEC_REVERT'
  | 'RETRY_STORM'
  | 'SIGNER_GAS_STARVED'
  | 'ADVERSE_INCLUSION'
  | 'EXECUTION_STALLED'
  | 'WORKFLOW_MISCONFIGURED'
  | 'SPEND_CAP_EXHAUSTED';

export type Severity = 'critical' | 'warning' | 'info';

export type IncidentStatus =
  | 'open'
  | 'diagnosing'
  | 'remediating'
  | 'resolved'
  | 'failed'
  | 'acknowledged';

export type RuleId =
  | 'R1'
  | 'R2'
  | 'R3'
  | 'R4'
  | 'R5'
  | 'R6'
  | 'R7'
  | 'R8'
  | 'R9'
  | 'R10';

/**
 * Who actually fixed it. `blackbox-proposed` means Blackbox planned the
 * remediation and a human's wallet signed it — a materially weaker claim than
 * `blackbox`, and the UI must never render one as the other.
 */
export type ResolvedBy = 'blackbox' | 'blackbox-proposed' | 'external' | 'unknown';

/** Which path put the transaction on chain. */
export type Executor = 'signer' | 'keeperhub' | 'keeperhub-workflow' | 'user-signed';

export type FinalStatus = 'succeeded' | 'failed' | 'skipped_by_guard' | 'skipped_by_policy';

/**
 * Every class, in the order `incidentClass` declares them in
 * packages/core/src/schemas.ts. That order is rule order for the first seven
 * and is not for the last three — R8 is SPEND_CAP_EXHAUSTED, which comes last
 * here. Matching core exactly is what lets a test compare the two lists and
 * fail when a rule adds a class the console cannot filter for. Three of these
 * were missing until that test existed.
 */
export const INCIDENT_CLASSES: readonly IncidentClass[] = [
  'STUCK_TRANSACTION',
  'NONCE_GAP',
  'GAS_UNDERPRICED',
  'SIM_PASS_EXEC_REVERT',
  'RETRY_STORM',
  'SIGNER_GAS_STARVED',
  'ADVERSE_INCLUSION',
  'EXECUTION_STALLED',
  'WORKFLOW_MISCONFIGURED',
  'SPEND_CAP_EXHAUSTED',
];

export const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'info'];

export const INCIDENT_STATUSES: readonly IncidentStatus[] = [
  'open',
  'diagnosing',
  'remediating',
  'resolved',
  'failed',
  'acknowledged',
];

/** The happy path, in order. `acknowledged` and `failed` sit outside it. */
export const LIFECYCLE: readonly IncidentStatus[] = [
  'open',
  'diagnosing',
  'remediating',
  'resolved',
];

// ------------------------------------------------------------------ incidents

export type IncidentSummary = {
  id: string;
  class: IncidentClass;
  severity: Severity;
  status: IncidentStatus;
  agentId: string;
  signer: string;
  chainId: number;
  /** Derived server-side by summarise(); the console renders, never recomputes. */
  summary: string;
  detectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolvedBy: ResolvedBy | null;
  confidence: number;
  ruleId: RuleId;
  hasRca: boolean;
  remediationStatus: FinalStatus | null;
  remediationTxHash: string | null;
  /** Sent by the server, absent from the mock — links are built from config. */
  explorerUrl?: string | null;
};

export type Corroboration = {
  latestNonce?: number;
  pendingNonce?: number;
  signerBalance?: string;
  baseFeeAtDetection?: string;
};

export type Evidence = {
  ruleId: RuleId;
  eventIds?: string[];
  /** Exactly what tripped the rule. Rendered verbatim, never renamed. */
  facts: Record<string, unknown>;
  corroboration?: Corroboration;
  /** Rules that also fired but lost to a more specific one. */
  suppressedRules?: RuleId[];
};

/**
 * Field names follow rootCauseAnalysisSchema, not the prose in the spec's page
 * 2.3, which calls these `narrative` and `prevention`. The schema is what the
 * diagnostician actually emits.
 */
export type Rca = {
  summary: string;
  contributingFactors: string[];
  timeline?: { at: string; what: string }[];
  recommendation: string;
  /** The literal "template" means the deterministic fallback wrote it. */
  model: string;
  generatedAt: string;
  promptVersion?: string;
};

export type RemediationAttempt = {
  attemptIndex: number;
  startedAt: string;
  completedAt?: string | null;
  guardsPassed: string[];
  guardsFailed: string[];
  txHash?: string;
  keeperHubActionId?: string;
  executor?: Executor;
  status: 'succeeded' | 'failed' | 'skipped';
  failureReason?: string;
  gasUsed?: string;
  explorerUrl?: string;
  description?: string;
  route?: string;
  /**
   * What KeeperHub's own validator said about the workflow just before it ran.
   * `knownFalsePositive` marks the templated-chain complaint we reported and
   * fixed upstream — a flag, but not a fault.
   */
  validation?: { valid: boolean; detail: string; knownFalsePositive: boolean };
};

export type Remediation = {
  playbookId: string;
  playbookName?: string;
  finalStatus: FinalStatus | 'pending';
  verifiedAt?: string | null;
  attempts: RemediationAttempt[];
};

/**
 * The server sends logicalActionId/nonce/simulationSuccess; the mock sends
 * kind/label. Neither sends both, so both are optional and the console derives
 * what is missing.
 */
export type IncidentEvent = {
  id: string;
  at: string;
  txHash?: string | null;
  blockNumber?: number | null;
  status?: string;
  kind?: 'submission' | 'detection' | 'rca' | 'remediation' | 'inclusion';
  label?: string;
  logicalActionId?: string;
  nonce?: number | null;
  simulationSuccess?: boolean | null;
  explorerUrl?: string | null;
};

export type IncidentDetail = IncidentSummary & {
  firstEventAt?: string;
  evidence: Evidence;
  rca: Rca | null;
  remediation: Remediation | null;
  events: IncidentEvent[];
  explorerUrls?: string[];
};

/**
 * The per-node record of one KeeperHub run, read through the operator's own
 * connection. Only they can see it, so the page asks for it separately rather
 * than folding it into the incident everybody can read.
 */
export type RunLogStep = {
  nodeId: string;
  nodeType: string;
  status: string;
  txHash: string | null;
  gasUsed: string | null;
  sponsored: boolean | null;
};

export type RunLogEntry = {
  executionId: string;
  status: string;
  error: string | null;
  steps: RunLogStep[];
};

export type RunLog = {
  incidentId: string;
  runs: RunLogEntry[];
};

/**
 * Whether the remediation record is intact. Each entry carries the hash of the
 * one before it, so this answers a question no single entry can: nothing has
 * been edited and nothing has been quietly removed.
 */
export type LedgerVerification = {
  ok: boolean;
  entries: number;
  /** Attempts recorded before the chain existed. Not verifiable, not claimed. */
  unchained: number;
  brokenAt: string | null;
  reason: 'ok' | 'hash_mismatch' | 'broken_link' | 'empty' | null;
  checkedAt: string;
};

/**
 * Where the connected organisation stands against its daily execution budget.
 * `ratio` is null only when there is no cap to be a fraction of.
 */
export type SpendPosition = {
  capWei: string | null;
  usedWei: string;
  ratio: number | null;
  uncapped: boolean;
};

export type IncidentList = {
  items: IncidentSummary[];
  nextCursor: string | null;
  total: number;
};

// ------------------------------------------------------------------- console

export type Stats = {
  /** Every incident recorded, not just the open ones. */
  incidentsDetected: number;
  openBySeverity: Record<Severity, number>;
  remediations: {
    total: number;
    succeeded: number;
    skipped: number;
    failed: number;
    gasWei: string;
  };
  /** null is "nothing qualified", not "instant". Renders as an em dash. */
  meanTimeToDetectionMs: number | null;
  meanTimeToRemediationMs: number | null;
  updatedAt: string;
};

export type ChainConfig = {
  chainId: number;
  name: string;
  testnet: boolean;
  privateMempool: boolean;
  /** A template containing {hash}. */
  explorerTxUrl: string;
};

export type Capabilities = {
  /** Blackbox holds a key or a KeeperHub org, and can submit a fix itself. */
  remediate: boolean;
  /** Server-signed chaos. False wherever the deployment holds no key. */
  chaos: boolean;
  /**
   * Chaos the visitor signs from their own wallet. True on the public
   * deployment precisely *because* it holds no key — so this, not `chaos`, is
   * what gates the panel a visitor can actually use.
   */
  signChaos: boolean;
  diagnose: boolean;
  signerHealth: boolean;
  proposeRemediation: boolean;
  /** An operator may connect their own KeeperHub account. */
  connectKeeperHub: boolean;
  /** A visitor may induce a real failure on this deployment's own org. */
  demo: boolean;
};

/** What this deployment actually reads, said plainly at /api/config. */
export type ConnectionsConfig = {
  available: boolean;
  detail?: string;
  sweepsOwnOrg: boolean;
  lifetimeDays?: { min: number; max: number; default: number };
  scope?: string;
  /** `local_only`: disconnecting deletes our copy and cannot revoke theirs. */
  revocation?: string;
  connected?: number;
  mine?: { status: string; expiresAt: string; watching: number } | null;
};

/**
 * An agent as Blackbox knows it: the addresses it signs from, where it runs,
 * and whether a fix for it can be executed rather than only proposed.
 */
export type Agent = {
  agentId: string;
  signers: string[];
  chainIds: number[];
  openIncidents: number;
  label: string | null;
  selfRemediation: boolean;
  /**
   * The circuit breaker Blackbox may pause for this agent. Null means it can
   * be diagnosed but not halted — which is worth showing, because registering
   * one is what turns detection into remediation.
   */
  breaker: { address: string; chainId: number; verified: boolean } | null;
};

/** Measured, not inferred — every field here is read from a chain. */
export type SignerHealth = {
  signer: string;
  chainId: number;
  balanceWei: string;
  latestNonce: number;
  pendingNonce: number;
  missingNonces: number[];
  /** How many more actions the balance affords, when that can be worked out. */
  runwayActions: number | null;
  openIncidents: IncidentSummary[];
};

/** A KeeperHub workflow this organisation has picked. Their name, not ours. */
export type WatchedWorkflow = {
  orgId: string;
  workflowId: string;
  name: string | null;
  active: boolean;
  connectedAt: string;
  lastRunAt: string | null;
};

/**
 * The state of one organisation's connection.
 *
 * `connected: false` with nothing else is the answer for an organisation that
 * has never connected as well as one that disconnected — from here they are the
 * same thing, which is why the shape is the same.
 */
export type Connection = {
  connected: boolean;
  orgId: string;
  status?: string;
  scope?: string;
  connectedAt?: string;
  expiresAt?: string;
  lastRefreshedAt?: string | null;
  lastSweptAt?: string | null;
  lastError?: string | null;
  watching: WatchedWorkflow[];
  /** `local_only`: disconnecting deletes our copy and cannot revoke theirs. */
  revocation?: string;
};

/** One of the account's own workflows, flagged with whether we watch it. */
export type OfferedWorkflow = {
  id: string;
  name: string;
  enabled: boolean | null;
  watched: boolean;
};

export type AppConfig = {
  chains: ChainConfig[];
  remediation: {
    dryRun: boolean;
    minConfidence: number;
    maxAttempts: number;
    signerAllowlist: string[];
    chainAllowlist: number[];
    budget: {
      maxRemediationsPerHour: number;
      maxGasWeiPerHour: string;
      /** Per agent — which for a KeeperHub agent means per workflow. */
      maxRemediationsPerDayPerAgent?: number;
    };
  };
  capabilities: Capabilities;
  connections?: ConnectionsConfig;
};

// ---------------------------------------------------------------- remediation

export type GuardFailure = { guard: string; reason: string };

/** 202 accepted, or 200 with the guards that refused. Both are normal. */
export type RemediateResponse = {
  incidentId: string;
  accepted: boolean;
  playbookId?: string;
  attemptId?: string;
  finalStatus?: string;
  guardsFailed?: GuardFailure[];
};

export type PlannedTransaction = {
  to: string;
  value: string;
  data: string | null;
  nonce: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  chainId: number;
  description: string;
  route?: string;
};

export type RemediationPlan = {
  incidentId: string;
  playbookId: string;
  /** false means Blackbox's own guards would block it. A human still may not. */
  actionable: boolean;
  signerRequired: string;
  chainId: number;
  guards: { passed: string[]; failed: string[] };
  transaction: PlannedTransaction | null;
  declined: { policy: string; reason: string } | null;
};

export type RemediationTxResult = {
  accepted: boolean;
  included: boolean;
  gasUsed: string;
  explorerUrl: string;
};

// -------------------------------------------------------------------- watched

export type WatchedAddress = {
  signer: string;
  chainId: number;
  agentId: string;
  label: string | null;
  registeredAt: string;
};

// ------------------------------------------------------------------- diagnose

export type DiagnoseSimulation = {
  performed: boolean;
  success: boolean | null;
  simulatedAtBlock: number | null;
  note?: string;
};

/**
 * One transaction explained, with nothing registered.
 *
 * Three shapes share this type: not found, found with no rule fired, and found
 * and classified. `found` and `class` decide which, and the fields belonging to
 * the other two are simply absent.
 */
export type DiagnoseResult = {
  txHash: string;
  chainId: number;
  chain?: string;
  found: boolean;
  detail?: string;
  signer?: string;
  nonce?: number;
  status?: string;
  blockNumber?: number;
  simulation?: DiagnoseSimulation;
  explorerUrl?: string;
  class?: IncidentClass | null;
  severity?: Severity;
  confidence?: number;
  ruleId?: RuleId;
  facts?: Record<string, unknown>;
  rca?: Rca | null;
  rcaSource?: string;
  /** What was examined to conclude nothing is wrong. */
  checked?: {
    latestNonce?: number;
    pendingNonce?: number;
    missingNonces?: number[];
    balanceWei?: string;
  };
};

// ---------------------------------------------------------------------- chaos

export type ChaosScenario = {
  id: string;
  name: string;
  induces: string[];
  enabled: boolean;
  deterministic: boolean;
  /** Why it does what it does — and, when disabled, why it cannot run. */
  note: string;
};

export type ChaosContext = {
  chainId: number;
  chainName: string;
  isTestnet: boolean;
  signer: string;
  signerBalanceWei: string;
  targets: Record<string, string | null>;
  items: ChaosScenario[];
};

/**
 * A failure planned for the caller's own wallet to sign.
 *
 * The transactions carry an absolute nonce, because occupying one specific
 * nonce is the whole point of some of these — so a wallet that helpfully
 * re-nonces produces something that costs money and induces nothing.
 */
export type ChaosPlan = {
  scenario: string;
  chainId: number;
  signer: string;
  induces?: string;
  expect?: string;
  expectedDetectionSeconds?: number;
  steps: {
    order: number;
    label: string;
    explanation: string;
    transaction: {
      to: string;
      value: string;
      data: string | null;
      nonce: number;
      maxFeePerGas: string;
      maxPriorityFeePerGas: string;
      gas?: string;
      chainId: number;
    } | null;
    waitForInclusion?: boolean;
  }[];
  /** True once the address is registered, so the loop runs unattended. */
  watching?: boolean;
  /** A stated refusal — not an error. */
  declined?: string | null;
};

export type ChaosRun = {
  runId: string;
  scenario: string;
  txHashes: string[];
  expectedIncidentClass?: string;
  expectedDetectionSeconds?: number;
};

// ------------------------------------------------------------------------ sse

export type ScanProgress = {
  fromBlock: number;
  toBlock: number;
  blocksScanned: number;
  matched: number;
  watching: number;
};

export type StreamEvent =
  | { type: 'hello'; data: { at: string; chainId: number } }
  | { type: 'incident.created'; data: IncidentSummary }
  | { type: 'incident.updated'; data: IncidentSummary }
  | { type: 'remediation.started'; data: { incidentId: string; playbookId: string } }
  | {
      type: 'remediation.succeeded';
      data: { incidentId: string; txHash: string; explorerUrl?: string };
    }
  | { type: 'remediation.failed'; data: { incidentId: string; reason: string } }
  | { type: 'chaos.started'; data: { runId: string; scenario: string; at: string } }
  | { type: 'chaos.completed'; data: { runId: string; scenario: string; incidentIds: string[] } }
  | { type: 'scan.progress'; data: ScanProgress }
  | { type: 'stats.updated'; data: Stats };

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
