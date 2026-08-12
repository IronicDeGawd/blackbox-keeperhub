import { useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { formatWei } from '../../lib/format';
import { session as currentSession } from '../../lib/session';
import { useConsole } from '../../lib/store';
import type { SpendPosition } from '../../lib/types';

/**
 * How much runway today has left.
 *
 * R8 raises an incident when the organisation's daily execution budget runs
 * out, which means Blackbox reads this number and, until now, only ever
 * mentioned it once it had already become a problem. A bar an operator can
 * glance at turns that late alarm into something they can see approaching.
 *
 * Only the organisation that connected can read its own budget, so this is
 * absent for everyone else rather than shown empty.
 */
export function Spend(): React.JSX.Element | null {
  const { stats } = useConsole();
  const session = currentSession();
  const [position, setPosition] = useState<SpendPosition | null>(null);
  // Re-read when a remediation lands, since that is what spends the budget.
  const pulse = `${session?.orgId ?? ''}:${stats?.remediations.total ?? 0}`;

  useEffect(() => {
    let live = true;
    if (!currentSession()) {
      setPosition(null);
      return;
    }
    void api
      .spend()
      .then((next) => {
        if (live) setPosition(next);
      })
      .catch((cause) => {
        // Not connected, or their side is down. Neither is worth a panel.
        if (cause instanceof ApiError && live) setPosition(null);
      });
    return () => {
      live = false;
    };
  }, [pulse]);

  if (position === null) return null;

  const percent = position.ratio === null ? null : Math.round(position.ratio * 100);
  const tight = percent !== null && percent >= 80;

  return (
    <section className="panel dash__spend">
      <h2 className="eyebrow eyebrow--accent">Today’s runway</h2>

      {position.uncapped ? (
        <p className="dash__spend-line">
          This organisation has no daily execution cap, so there is nothing here to run out.{' '}
          {formatWei(position.usedWei)} spent today.
        </p>
      ) : (
        <>
          <div
            className={`dash__spend-bar ${tight ? 'dash__spend-bar--tight' : ''}`}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? 0}
            aria-label="Daily execution budget used"
          >
            <span className="dash__spend-fill" style={{ width: `${percent ?? 0}%` }} />
          </div>

          <dl className="dash__spend-figures">
            <div>
              <dt>Used</dt>
              <dd className="num">{percent}%</dd>
            </div>
            <div>
              <dt>Spent today</dt>
              <dd className="num">{formatWei(position.usedWei)}</dd>
            </div>
            <div>
              <dt>Daily cap</dt>
              <dd className="num">{formatWei(position.capWei)}</dd>
            </div>
          </dl>

          {tight ? (
            <p className="dash__spend-warn" role="status">
              Close to the cap. When it is reached, KeeperHub refuses further executions and
              Blackbox raises SPEND_CAP_EXHAUSTED.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
