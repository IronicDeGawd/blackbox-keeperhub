import { useEffect, useRef, useState } from 'react';
import { useConsole } from '../../lib/store';

/**
 * The stream, as it arrives.
 *
 * This is not "Caught most recently" in another shape. That panel is
 * incidents; this is *events*, including every one that never becomes an
 * incident — a scan sweeping blocks, a remediation starting, a chaos run
 * being induced. It is also the thing somebody watching a demo actually
 * looks at while they wait for the arc to complete.
 *
 * Newest at the bottom, like a terminal. The pane scrolls itself, and stops
 * doing so while the pointer is inside it or the reader has scrolled up —
 * yanking somebody away from the line they were reading is the one thing a
 * live log must not do.
 */
export function EventLog(): React.JSX.Element {
  const { log, connection } = useConsole();
  const pane = useRef<HTMLDivElement | null>(null);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const node = pane.current;
    if (!node || held) return;
    node.scrollTop = node.scrollHeight;
  }, [log, held]);

  /**
   * Scrolled away from the bottom means they are reading something. Coming
   * back to the bottom hands control back, so it does not stay frozen for the
   * rest of the session.
   */
  const onScroll = (): void => {
    const node = pane.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 8;
    setHeld(!atBottom);
  };

  return (
    <section className="panel dash__log">
      <header className="dash__log-head">
        <h2 className="eyebrow eyebrow--accent">Everything, as it happens</h2>
        {held ? <span className="dash__log-held">paused — scroll down to follow</span> : null}
      </header>

      <div
        className="dash__log-pane"
        ref={pane}
        onScroll={onScroll}
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={onScroll}
        role="log"
        aria-live="off"
        aria-label="Event stream"
        tabIndex={0}
      >
        {log.length === 0 ? (
          <p className="dash__log-empty">
            {connection === 'connected'
              ? 'Connected. Nothing has happened yet.'
              : 'Waiting for the stream.'}
          </p>
        ) : (
          <ol className="dash__log-lines">
            {log.map((line) => (
              <li className={`dash__log-line dash__log-line--${line.tone}`} key={line.key}>
                <time className="dash__log-at">{clock(line.at)}</time>
                <span className="dash__log-tag">{line.tag}</span>
                <span className="dash__log-text">{line.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

/** Wall-clock to the second. Relative times say nothing about the gaps. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour12: false });
}
