import { useEffect, useRef, useState } from 'react';

/**
 * One real incident, end to end.
 *
 * "Detect, explain, fix" was four paragraphs of prose. As a diagram it is one
 * glance, and the elapsed times — which are the product's actual measured
 * performance and appeared nowhere on the page — become the part that argues.
 *
 * Every figure here is taken from a single incident on the public deployment,
 * not composed from several. The fix was planned by Blackbox and signed by the
 * account's own wallet, which is a weaker claim than executing it, and the
 * diagram says so rather than rounding it up.
 */

const STAGES: { at: string; head: string; line: string; href?: string; hash?: string }[] = [
  {
    at: '13:33:50',
    head: 'Execution observed',
    line: 'A submission queued above nonce 122, which was never filled.',
  },
  {
    at: '13:34:13',
    head: 'NONCE_GAP raised',
    line: 'R2, critical, confidence 0.90 — with the nonces it measured.',
  },
  {
    at: '13:35:13',
    head: 'Fix verified onchain',
    line: 'Planned by Blackbox, signed by the account’s own wallet, then verified.',
    hash: '0x5f80b82d',
    href: 'https://sepolia.etherscan.io/tx/0x5f80b82d4aeb446b81b74e76bfd7ac4be7445ac7e6a5bed68738d2168252afa8',
  },
];

/** The gaps between them, which is the interesting part. */
const ELAPSED = ['22.9s', '1m 00s'];

export function Arc(): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null);
  const [drawn, setDrawn] = useState(false);

  /**
   * Drawn once, when it is first looked at. Firing on mount would spend the
   * animation while the section is still below the fold; repeating it on every
   * scroll past would make the page fidget.
   */
  useEffect(() => {
    const node = root.current;
    if (!node || drawn) return;
    if (typeof IntersectionObserver === 'undefined') {
      setDrawn(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setDrawn(true);
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [drawn]);

  return (
    <section>
      <h2 className="eyebrow eyebrow--ruled">One incident, start to finish</h2>
      <p className="landing__note">
        A nonce gap on Sepolia, on 11 August. Times are from the incident record, not from a
        retelling of it.
      </p>

      <div className={`arc ${drawn ? 'arc--drawn' : ''}`} ref={root}>
        {STAGES.map((stage, index) => (
          <div className="arc__pair" key={stage.head}>
            <div className={`arc__stage ${stage.hash ? 'arc__stage--fix' : ''}`}>
              <time className="arc__time">{stage.at}</time>
              <p className="arc__head">{stage.head}</p>
              <p className="arc__line">{stage.line}</p>
              {stage.href ? (
                <a className="arc__hash" href={stage.href} target="_blank" rel="noreferrer">
                  {stage.hash} ↗
                </a>
              ) : null}
            </div>

            {index < ELAPSED.length ? (
              <div className="arc__gap">
                <span className="arc__rule" aria-hidden="true" />
                <span className="arc__elapsed">{ELAPSED[index]} later</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
