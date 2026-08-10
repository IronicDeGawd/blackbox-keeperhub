# Live end-to-end scripts

Every script here spends real gas on Ethereum Sepolia and produces real
transaction hashes. Nothing is simulated. Run from this directory's parent
package after `pnpm -r build`, because they import sibling `dist/` output:

```
cd packages/chaos
node e2e/c2-nonce-gap.mjs            # R2 detection, healed by hand
node e2e/c3-sim-pass-exec-revert.mjs # R4, via the armed trap
node e2e/c4-retry-storm.mjs          # R5, four attempts at an always-reverting call
node e2e/p2-remediate-gap.mjs        # full arc: detect -> P2 -> verify -> resolved
node e2e/p4-keeperhub-breaker.mjs    # R5 -> P4 pause, submitted through KeeperHub
node e2e/diagnose.mjs                # Gemini RCA over whatever is in the database
```

`harness.mjs` holds the wiring they share — env, database, chain client,
recorder, and the polling loop. Detection is not instant by design, so every
script polls; they should not each invent their own version of that.

Notes:

- `p4-keeperhub-breaker.mjs` leaves the circuit breaker **paused**. It prints
  the `cast send ... "unpause()"` command to undo it. A paused breaker silently
  breaks every later run.
- `c3-sim-pass-exec-revert.mjs` disarms the trap on its way out.
- These write into the same database the tests use, so results mix with test
  fixtures unless you truncate first.
