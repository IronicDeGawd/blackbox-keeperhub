import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Wei-scale values are stored as `text`, not `numeric` or `bigint`.
 * Postgres `bigint` overflows above 2^63 and JS drivers hand `numeric` back as
 * a float in some paths; either would corrupt a gas price silently. Text
 * round-trips a `bigint` exactly, and no arithmetic happens in SQL.
 */

export const executionEvents = pgTable(
  'execution_events',
  {
    id: text('id').primaryKey(),
    /** Unique per attempt: the normaliser suffixes the receipt index. */
    sourceId: text('source_id').notNull(),
    logicalActionId: text('logical_action_id').notNull(),
    attemptIndex: integer('attempt_index').notNull(),
    agentId: text('agent_id').notNull(),
    signer: text('signer').notNull(),
    chainId: integer('chain_id').notNull(),

    /**
     * How this agent executes, and therefore which rules can apply to it.
     *
     * `keeperhub` means a managed wallet: KeeperHub owns gas estimation, nonce
     * management and ordering, so such an agent has no nonce queue of its own
     * and cannot have a nonce gap. `signer` means an agent holding its own key,
     * which can. Null is an event recorded before the distinction existed, and
     * reads as unknown rather than as either kind.
     */
    agentKind: text('agent_kind'),
    /** The KeeperHub workflow this run belonged to, when it was one. */
    workflowId: text('workflow_id'),

    // Flattened because rules filter on these; the rest stays in JSONB.
    txHash: text('tx_hash'),
    nonce: integer('nonce'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    outcomeStatus: text('outcome_status').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }),
    simulationSuccess: boolean('simulation_success'),

    trigger: jsonb('trigger').notNull(),
    simulation: jsonb('simulation').notNull(),
    submission: jsonb('submission').notNull(),
    outcome: jsonb('outcome').notNull(),
    /** Never discarded — the vendor payload exactly as received. */
    raw: jsonb('raw'),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    // Dedupe key: re-polling the same execution must not duplicate attempts.
    sourceUnique: uniqueIndex('execution_events_source_attempt_idx').on(t.sourceId, t.attemptIndex),
    // The detector's hot path: this signer's recent events, oldest first.
    signerWindow: index('execution_events_signer_window_idx').on(
      t.signer,
      t.chainId,
      t.submittedAt,
    ),
    byAction: index('execution_events_action_idx').on(t.logicalActionId),
    byNonce: index('execution_events_nonce_idx').on(t.signer, t.chainId, t.nonce),
  }),
);

export const incidents = pgTable(
  'incidents',
  {
    id: text('id').primaryKey(),
    /** agentId|signer|chainId|class — the correlation key. */
    key: text('key').notNull(),
    class: text('class').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull(),
    agentId: text('agent_id').notNull(),
    signer: text('signer').notNull(),
    chainId: integer('chain_id').notNull(),

    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull(),
    firstEventAt: timestamp('first_event_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** blackbox | external | unknown. Kept apart from *whether* it resolved. */
    resolvedBy: text('resolved_by'),

    ruleId: text('rule_id').notNull(),
    confidence: real('confidence').notNull(),
    evidence: jsonb('evidence').notNull(),
    rca: jsonb('rca'),
    remediation: jsonb('remediation'),
  },
  (t) => ({
    // Only one incident per key may be open at a time; the tracker relies on it.
    openByKey: index('incidents_key_status_idx').on(t.key, t.status),
    timeline: index('incidents_detected_idx').on(t.detectedAt),
    bySigner: index('incidents_signer_idx').on(t.signer, t.chainId),
  }),
);

/**
 * Addresses to watch.
 *
 * The difference between a demo and a product: without this, Blackbox only
 * ever sees transactions something told it about, which in practice means its
 * own chaos harness. Registering an address makes the block scanner pick up
 * everything that address does, with no integration on the agent's side at all.
 */
export const watchedSigners = pgTable(
  'watched_signers',
  {
    signer: text('signer').notNull(),
    chainId: integer('chain_id').notNull(),
    /** Whose incidents these are in the console. */
    agentId: text('agent_id').notNull(),
    label: text('label'),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.signer, t.chainId] }),
    byChain: index('watched_signers_chain_idx').on(t.chainId, t.active),
  }),
);

/**
 * Ingestion cursors. The recorder is a long-lived loop that must survive
 * restarts without replaying or skipping, so its position is durable.
 */
export const ingestCursors = pgTable('ingest_cursors', {
  /** Source identifier, e.g. `keeperhub:<orgId>`. */
  source: text('source').primaryKey(),
  cursor: text('cursor'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

/**
 * Executions the recorder is watching.
 *
 * `/api/executions` 404s and `/execute/{id}/status` needs an id already in
 * hand, so an execution Blackbox submits is registered here at submission time
 * and polled until it reaches a terminal state. This table is that watchlist,
 * and it is durable because a restart mid-flight would otherwise lose track of
 * exactly the transactions most likely to be in trouble.
 *
 * There *is* a listing endpoint — `/api/analytics/runs`, behind their
 * `list_executions` tool — and the recorder reads it for the whole
 * organisation's history. It does not replace this table: it reports a run
 * after the fact and on its own schedule, whereas an execution registered here
 * is polled from the moment it is submitted, which is the difference between
 * noticing a stuck transaction and reading about one.
 */
export const watchedExecutions = pgTable(
  'watched_executions',
  {
    executionId: text('execution_id').primaryKey(),
    agentId: text('agent_id').notNull(),
    signer: text('signer').notNull(),
    chainId: integer('chain_id').notNull(),
    /** Fee parameters the audit record does not carry (PRD §3.1 wrapper). */
    submitted: jsonb('submitted'),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    pollCount: integer('poll_count').notNull().default(0),
    /** Set once the execution reaches a terminal state; stops the polling. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    due: index('watched_executions_due_idx').on(t.settledAt, t.lastPolledAt),
    bySigner: index('watched_executions_signer_idx').on(t.signer, t.chainId),
  }),
);

/**
 * Transactions the recorder is watching directly on chain.
 *
 * Not everything worth watching goes through KeeperHub. The chaos harness has
 * to submit deliberately underpriced or nonce-gapped transactions, which
 * KeeperHub will not do because it picks fees server-side and manages nonces.
 * Those are still real transactions with real hashes; they simply have no
 * execution record.
 *
 * This is registration, not mempool watching (PRD §2.2): the hash is known
 * because something told us about it. The same path lets Blackbox observe any
 * signer whose transaction hashes are reported to it.
 */
export const watchedTransactions = pgTable(
  'watched_transactions',
  {
    txHash: text('tx_hash').primaryKey(),
    agentId: text('agent_id').notNull(),
    signer: text('signer').notNull(),
    chainId: integer('chain_id').notNull(),
    /** Free-form label, e.g. the chaos scenario that produced it. */
    label: text('label'),
    /**
     * What the submitter simulated before broadcasting, when it simulated at
     * all. A raw transaction observed from the chain carries no simulation, and
     * R4 requires one — so a submitter that did simulate has to be able to say
     * so, or "simulation passed, execution reverted" is undetectable outside
     * KeeperHub's own records.
     */
    simulation: jsonb('simulation'),
    /**
     * Groups retries of one logical action. Derived from the hash when absent,
     * which makes every transaction its own action — correct for an unrelated
     * transfer, and fatal for R5, which counts repeated failures of the *same*
     * action. Only the submitter knows that two hashes were the same attempt.
     */
    logicalActionId: text('logical_action_id'),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    pollCount: integer('poll_count').notNull().default(0),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    due: index('watched_transactions_due_idx').on(t.settledAt, t.lastPolledAt),
    bySigner: index('watched_transactions_signer_idx').on(t.signer, t.chainId),
  }),
);

/**
 * Per-signer detector state that must persist across polls. R2 will not fire
 * until a nonce gap has been seen for several consecutive evaluations, and a
 * restart must not reset that count to zero or a real gap goes unreported.
 */
export const signerState = pgTable('signer_state', {
  signer: text('signer').notNull(),
  chainId: integer('chain_id').notNull(),
  consecutiveGapPolls: integer('consecutive_gap_polls').notNull().default(0),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
}, (t) => ({
  pk: uniqueIndex('signer_state_pk').on(t.signer, t.chainId),
}));

/**
 * Every remediation attempt, successful or not, for budget enforcement.
 *
 * The rolling caps in PRD §6 are on both count and cumulative gas, and they
 * must survive a restart: a process that forgets what it has already spent
 * would happily blow through an hourly cap after every bounce. Failed attempts
 * count too — they cost gas and they are evidence that retrying is not working.
 */
export const remediationLedger = pgTable(
  'remediation_ledger',
  {
    id: text('id').primaryKey(),
    incidentId: text('incident_id').notNull(),
    playbookId: text('playbook_id').notNull(),
    signer: text('signer').notNull(),
    chainId: integer('chain_id').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    /** Wei, as text. Zero when the attempt never reached the chain. */
    gasSpentWei: text('gas_spent_wei').notNull().default('0'),
    status: text('status').notNull(),
    txHash: text('tx_hash'),
    /** signer | keeperhub | user-signed. Absent on older rows. */
    executor: text('executor'),
  },
  (t) => ({
    budget: index('remediation_ledger_budget_idx').on(t.signer, t.chainId, t.attemptedAt),
    byIncident: index('remediation_ledger_incident_idx').on(t.incidentId),
  }),
);

/**
 * An operator's session, proved by a KeeperHub organisation key.
 *
 * The key itself is never stored — it is a bearer credential for someone
 * else's account, and holding one would make this database worth stealing.
 * What is stored is a hash of the session token we issued and a hash of the
 * key, the latter only so the same key resolves to the same session rather
 * than minting a new one on every sign-in.
 */
export const orgSessions = pgTable(
  'org_sessions',
  {
    /** SHA-256 of the token handed to the caller. The token is never at rest. */
    tokenHash: text('token_hash').primaryKey(),
    /**
     * Stable identity for the organisation: the lowest key id in the org's own
     * key list, which every key belonging to that organisation can see. There
     * is no endpoint that names an organisation — `/api/organizations` answers
     * 401 and `/api/organization` and `/api/me` do not exist — so this is
     * derived rather than read.
     */
    orgId: text('org_id').notNull(),
    keyHash: text('key_hash').notNull(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    /** Revocation is one update, and a revoked session is kept for the audit. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byKey: index('org_sessions_key_idx').on(t.keyHash),
    byOrg: index('org_sessions_org_idx').on(t.orgId),
  }),
);

/**
 * Who owns an agent, and may therefore act on it.
 *
 * First registration claims it. A claim is not a security boundary against the
 * chain — anyone can watch a public address — it is a boundary against acting:
 * remediating, relabelling, or spending another operator's budget.
 */
export const agentOwners = pgTable(
  'agent_owners',
  {
    agentId: text('agent_id').primaryKey(),
    orgId: text('org_id').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull(),
  },
  (t) => ({ byOrg: index('agent_owners_org_idx').on(t.orgId) }),
);
