import type { Incident } from '@blackbox/core';
import type { RemediationExecutor } from '../remediator.js';
import type { PlaybookPlan } from '../playbooks.js';

type Submit = Extract<PlaybookPlan, { kind: 'submit' }>;

/**
 * Chooses a submission path per plan, and says why when there is none.
 *
 * The split is forced by what KeeperHub is: a sponsored relayer that never
 * signs as the agent's signer. So a plan that names a nonce can only go through
 * a key-holding executor, and a plan that does not is preferably KeeperHub's,
 * because that keeps the remediation inside the customer's existing audit
 * trail and its own spend controls.
 *
 * When neither path can serve a plan, this throws with the reason rather than
 * silently picking the wrong one — the remediator turns that into a failed
 * attempt in the ledger, which is the honest record.
 */
export class RoutingExecutor implements RemediationExecutor {
  constructor(
    private readonly options: {
      /**
       * Preferred for anything that does not need a nonce. A remediation that
       * runs as a KeeperHub workflow lands in the operator's own dashboard with
       * per-node logs and their existing spend controls, rather than in a side
       * channel only Blackbox can see.
       */
      workflow?: RemediationExecutor;
      keeperHub?: RemediationExecutor;
      signer?: RemediationExecutor & { holdsKeyFor(signer: string): boolean };
    },
  ) {}

  route(plan: Submit, incident: Incident): RemediationExecutor {
    const { workflow, keeperHub, signer } = this.options;
    const haveKey = signer?.holdsKeyFor(incident.signer) ?? false;

    if (plan.nonce !== undefined) {
      if (!haveKey) {
        throw new Error(
          `Plan "${plan.description}" needs nonce ${plan.nonce} on ${incident.signer}. ` +
            `KeeperHub executes through a sponsored relayer at the sponsor's nonce — as a workflow ` +
            `action or a direct call alike — so neither can serve this plan, and no key is held ` +
            `for that signer. Register the signer's key, or have its owner sign the plan.`,
        );
      }
      return signer!;
    }

    // Workflow first: same execution engine, but visible and governable where
    // the operator already works.
    if (workflow) return workflow;
    if (keeperHub) return keeperHub;
    if (haveKey) return signer!;
    throw new Error(
      `No executor available for "${plan.description}": no KeeperHub workflow or direct execution ` +
        `is configured, and no key is held for ${incident.signer}`,
    );
  }

  async submit(params: Parameters<RemediationExecutor['submit']>[0]): ReturnType<
    RemediationExecutor['submit']
  > {
    return this.route(params.plan, params.incident).submit(params);
  }

  async verify(params: Parameters<RemediationExecutor['verify']>[0]): ReturnType<
    RemediationExecutor['verify']
  > {
    // Verification is a receipt lookup, identical whichever path submitted.
    const executor = this.options.workflow ?? this.options.keeperHub ?? this.options.signer;
    if (!executor) throw new Error('No executor configured to verify with');
    return executor.verify(params);
  }
}
