import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { EM_DASH, formatDuration } from '../../lib/format';

/**
 * Three numbers about the product, not about today's queue.
 *
 * The severity buckets, the gas counter and the live feed belong to the
 * console; these are the only figures that say something to a reader deciding
 * whether this works at all. Read once on load — a front page that ticks is a
 * dashboard, which is what this page stopped being.
 *
 * Every one has an honest zero: nothing detected yet reads as an em dash with
 * its caption intact, never as a failure and never as a fabricated number.
 */
export function Numbers(): React.JSX.Element | null {
  const [figures, setFigures] = useState<{
    detected: number;
    fixed: number;
    detectionMs: number | null;
  } | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .stats()
      .then((stats) => {
        if (!live) return;
        setFigures({
          detected: stats.incidentsDetected,
          fixed: stats.remediations.succeeded,
          detectionMs: stats.meanTimeToDetectionMs,
        });
      })
      .catch(() => {
        // Unreachable from here is not something to announce on a front page.
        if (live) setFigures(null);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!figures) return null;

  return (
    <section className="numbers" aria-label="What this deployment has done">
      <div className="numbers__item">
        <span className="numbers__value num">
          {figures.detected === 0 ? EM_DASH : figures.detected}
        </span>
        <span className="numbers__label">incidents detected</span>
      </div>
      <div className="numbers__item">
        <span className="numbers__value num">{figures.fixed === 0 ? EM_DASH : figures.fixed}</span>
        <span className="numbers__label">fixes executed onchain</span>
      </div>
      <div className="numbers__item">
        <span className="numbers__value num">
          {figures.detectionMs === null ? EM_DASH : detection(figures.detectionMs)}
        </span>
        <span className="numbers__label">mean time to detection</span>
      </div>
      <p className="numbers__note">On this deployment, since it was first switched on.</p>
    </section>
  );
}

/**
 * Sub-second detection is real and worth saying, but "0ms" reads as a broken
 * counter rather than as a fast one, so it is stated as a bound instead.
 */
function detection(ms: number): string {
  return ms < 1000 ? 'under 1s' : formatDuration(ms);
}
