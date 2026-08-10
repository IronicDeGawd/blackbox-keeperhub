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
      keeperHub?: RemediationExecutor;
      signer?: RemediationExecutor & { holdsKeyFor(signer: string): boolean };
    },
  ) {}

  route(plan: Submit, incident: Incident): RemediationExecutor {
    const { keeperHub, signer } = this.options;
    const haveKey = signer?.holdsKeyFor(incident.signer) ?? false;

    if (plan.nonce !== undefined) {
      if (!haveKey) {
        throw new Error(
          `Plan "${plan.description}" needs nonce ${plan.nonce} on ${incident.signer}. ` +
            `KeeperHub submits through a sponsored relayer at the sponsor's nonce, so it cannot ` +
            `serve this plan, and no key is held for that signer. Register the signer's key with ` +
            `Blackbox to enable nonce-precise remediation.`,
        );
      }
      return signer!;
    }

    if (keeperHub) return keeperHub;
    if (haveKey) return signer!;
    throw new Error(
      `No executor available for "${plan.description}": KeeperHub is not configured and no key ` +
        `is held for ${incident.signer}`,
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
    const executor = this.options.keeperHub ?? this.options.signer;
    if (!executor) throw new Error('No executor configured to verify with');
    return executor.verify(params);
  }
}
