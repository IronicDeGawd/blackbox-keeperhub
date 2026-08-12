# Demo narration

Target 2:30–3:00. Read at a normal pace; the driver waits for you.
Say what is happening, not what it means. Let the timestamps do the boasting.

Run: `node tools/demo/drive.mjs` — Enter advances, `q` stops.
Rehearse without recording: `node tools/demo/drive.mjs --headless --auto 900 --to 9`.

---

**01 · Front page** *(~15s)*

> Agents are good at reasoning and bad at execution. A nonce gap wedges a
> signer and everything behind it stops. A gas estimate goes stale. A call
> simulates clean and reverts on inclusion. None of it raises an error the
> agent knows how to report — so you find out from a user, or from the balance.
> Blackbox watches the execution, works out what went wrong, and fixes it.

**02 · The specimen** *(~12s)*

> This is one real incident, rendered by the same components the console uses.
> Note what it leads with: not a verdict, the numbers. Nonce 122 never filled,
> one action blocked behind it, and five consecutive polls where two were
> required. Every detection is a measurement against a threshold, so it can be
> argued with.

**03 · Three numbers** *(~8s)*

> Four incidents on this deployment, one fix executed onchain, and a mean of
> about thirteen seconds from the failure happening to Blackbox noticing.

**04 · The arc** *(~15s)*

> End to end on one incident. The execution was observed here. Twenty-three
> seconds later the nonce gap was raised. A minute after that the fix was
> verified onchain — and that hash is a link. This one was planned by Blackbox
> and signed by the account's own wallet, which is a weaker claim than
> executing it, so it says so.

**05 · What it catches** *(~10s)*

> Ten deterministic checks. No model decides whether something is wrong. And
> this list is the scope — a failure that is not here will not be found.

**06 · Receipts** *(~8s)*

> Every one of these is a real transaction on a public chain. There are no
> simulated remediations anywhere in the product.

**07 · Into the console** *(~6s)*

> That is the product. This is the instrument.

**08 · The ledger line** *(~10s)*
*Cut this beat if the line is not there — it appears once a fix is recorded.*

> Every remediation entry carries the hash of the one before it. So it is not
> just that each fix is checkable — the sequence is. Nothing has been edited,
> and nothing has been quietly deleted. That endpoint is public; check it
> yourself.

**09 · The event log** *(~10s)*

> Everything as it arrives, including what never becomes an incident — blocks
> being swept, runs starting, fixes going out.

**10 · Break something** *(~12s)*

> Now let's cause a failure. This runs a workflow that asks to spend beyond the
> organisation's daily cap. KeeperHub refuses it before any chain is involved,
> so it costs no gas — and Blackbox reads the refusal out of the audit trail,
> exactly as it would read yours.

**11 · The wait** *(~15s — say almost nothing)*

> Nothing has been reloaded.

*…let it land, then:*

> There it is. Ten seconds or so, unprompted.

**12 · Open it** *(~8s)*

> Workflow misconfigured. Not "it failed" — refused repeatedly, before the
> chain, at the same step. That is a broken definition, not bad luck, and
> retrying will not help.

**13 · The evidence** *(~10s)*

> The facts it judged on, each beside the threshold it was compared against,
> named exactly as the rule wrote them so you can go and find the rule.

**14 · The run log** *(~12s)*
*Needs a signed-in owning account. Cut it if you record anonymously.*

> And this is the run itself, step by step, read through your own KeeperHub
> connection. Which node failed, and what it said. Before this existed, the
> answer to "which step" was another dashboard.

**15 · The fix** *(~10s)*

> And where a fix ran, the transaction hash, linked to the explorer. That is
> the whole claim: a failure nobody reported, found, explained with numbers,
> and repaired with something you can look up.

---

## Notes for the cut

- **The money shot is beat 11.** Give it room. Everything before it is setup.
- **The 30-minute cooldown is global.** One press per half hour, for everyone.
  Do not rehearse it. `curl -s <base>/api/demo` reports `ready`.
- Beat 08 needs a chained ledger entry; beat 14 needs a session that owns the
  agent. Both fail gracefully — the driver prints a note and moves on.
- Record 1440x900, no music, no cursor highlighting. Cut the pauses out, not
  the silences after the incident lands.
