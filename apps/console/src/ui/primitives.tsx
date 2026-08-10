import { useCallback, useEffect, useRef, useState } from 'react';
import { absoluteTime, relativeTime, truncateAddress, truncateHash } from '../lib/format';
import type { IncidentStatus, ResolvedBy, Severity } from '../lib/types';
import { useNow } from './useNow';

/** The small pieces every page reuses. */

export function SeverityDot({ severity }: { severity: Severity }): React.JSX.Element {
  return <span className={`sevdot sevdot--${severity}`} aria-hidden="true" />;
}

export function ClassBadge({ value }: { value: string }): React.JSX.Element {
  return <span className="classbadge">{value}</span>;
}

/** The rule that fired is evidence, not debug output, so it is shown. */
export function RuleTag({ ruleId }: { ruleId: string }): React.JSX.Element {
  return (
    <span className="ruletag" title={`Detected by rule ${ruleId}`}>
      {ruleId}
    </span>
  );
}

export function StatusPill({ status }: { status: IncidentStatus }): React.JSX.Element {
  return <span className={`pill pill--${status}`}>{status}</span>;
}

const RESOLVED_BY_LABEL: Record<ResolvedBy, string> = {
  blackbox: 'by blackbox',
  'blackbox-proposed': 'blackbox planned · user signed',
  external: 'fixed elsewhere',
  unknown: 'attribution unknown',
};

const RESOLVED_BY_TITLE: Record<ResolvedBy, string> = {
  blackbox: 'Blackbox detected this and executed the fix itself.',
  'blackbox-proposed':
    "Blackbox planned the fix and the account's own wallet signed it. Blackbox did not act alone.",
  external: 'Something other than Blackbox resolved this.',
  unknown: 'The incident closed without an attributable remediation.',
};

/**
 * Attribution, kept distinct from the status.
 *
 * `blackbox-proposed` is a fix a human signed, and rendering it as `blackbox`
 * would claim autonomous remediation that did not happen. `external` closed on
 * its own and is not a success for anyone here.
 */
export function ResolvedByTag({ resolvedBy }: { resolvedBy: ResolvedBy }): React.JSX.Element {
  return (
    <span className={`attrib attrib--${resolvedBy}`} title={RESOLVED_BY_TITLE[resolvedBy]}>
      {RESOLVED_BY_LABEL[resolvedBy]}
    </span>
  );
}

export function RelativeTime({ at }: { at: string }): React.JSX.Element {
  const now = useNow();
  return (
    <time className="reltime" dateTime={at} title={absoluteTime(at)}>
      {relativeTime(at, now)}
    </time>
  );
}

/**
 * Truncated on screen, whole on copy. The short form is for reading; anything
 * pasted into an explorer or a terminal has to be the full value.
 */
export function CopyableAddress({
  value,
  kind = 'address',
}: {
  value: string;
  kind?: 'address' | 'hash';
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(
    (event: React.MouseEvent) => {
      // Rows are links; copying an address inside one must not navigate.
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard?.writeText(value).then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      });
    },
    [value],
  );

  return (
    <button
      type="button"
      className="copyable"
      onClick={copy}
      title={`${value} — click to copy`}
      aria-label={`Copy ${value}`}
    >
      {copied ? 'copied' : kind === 'hash' ? truncateHash(value) : truncateAddress(value)}
    </button>
  );
}

export function ExplorerLink({
  url,
  children,
}: {
  url: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <a
      className="explorer"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => event.stopPropagation()}
    >
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

export function SkeletonRows({ count = 5 }: { count?: number }): React.JSX.Element {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        // Skeletons hold the row's exact height so the layout does not jump
        // when the real rows arrive.
        <div className="skeleton-row" key={index}>
          <span className="skeleton skeleton--dot" />
          <span className="skeleton skeleton--head" />
          <span className="skeleton skeleton--body" />
        </div>
      ))}
    </div>
  );
}
