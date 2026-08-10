import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { chainName, explorerTxUrl } from '../../lib/explorer';
import type { ChainConfig, IncidentSummary } from '../../lib/types';
import {
  ClassBadge,
  CopyableAddress,
  ExplorerLink,
  RelativeTime,
  ResolvedByTag,
  RuleTag,
  SeverityDot,
  StatusPill,
} from '../../ui/primitives';

/**
 * Marks a row for a moment when its status changes.
 *
 * open → diagnosing → remediating → resolved arriving in one row is the whole
 * product told in one motion, and a row that changes silently while you are
 * reading another one is a change you miss. Reaching `resolved` gets its own
 * treatment because that is the moment the fix landed.
 */
function useStatusFlash(status: string): string {
  const previous = useRef(status);
  const [flash, setFlash] = useState('');

  useEffect(() => {
    if (previous.current === status) return undefined;
    previous.current = status;
    setFlash(status === 'resolved' ? 'row--landed' : 'row--changed');
    const timer = setTimeout(() => setFlash(''), 1600);
    return () => clearTimeout(timer);
  }, [status]);

  return flash;
}

export function IncidentRow({
  incident,
  chains,
}: {
  incident: IncidentSummary;
  chains: ChainConfig[];
}): React.JSX.Element {
  const flash = useStatusFlash(incident.status);
  const txUrl = explorerTxUrl(
    chains,
    incident.chainId,
    incident.remediationTxHash,
    incident.explorerUrl,
  );

  return (
    // The row is a stretched link rather than a wrapping one: the explorer link
    // and the copy button are interactive elements of their own, and an anchor
    // inside an anchor is invalid HTML that React refuses to render.
    <div className={`row row--${incident.severity} ${flash}`.trim()}>
      <Link
        to="/incidents/$id"
        params={{ id: incident.id }}
        className="row__target"
        aria-label={`${incident.class} on ${incident.agentId}: ${incident.summary}`}
      />
      <span className="row__rail" aria-hidden="true" />

      <div className="row__head">
        <SeverityDot severity={incident.severity} />
        <span className={`row__sev row__sev--${incident.severity}`}>{incident.severity}</span>
        <ClassBadge value={incident.class} />
        <RuleTag ruleId={incident.ruleId} />
        <span className="row__who">
          {incident.agentId}
          <span className="dim"> · </span>
          <CopyableAddress value={incident.signer} />
        </span>
        <span className="row__gap" />
        {/* Only worth the space when more than one chain is configured, but
            then it is essential: which chain an incident is on decides whether
            Blackbox can remediate it at all. */}
        {chains.length > 1 ? (
          <span className="row__chain">{chainName(chains, incident.chainId)}</span>
        ) : null}
        <RelativeTime at={incident.detectedAt} />
      </div>

      <div className="row__foot">
        <span className="row__summary">{incident.summary}</span>
        <span className="row__gap" />
        {txUrl && incident.remediationTxHash ? (
          <ExplorerLink url={txUrl}>{incident.remediationTxHash.slice(0, 10)}…</ExplorerLink>
        ) : null}
        {incident.resolvedBy ? <ResolvedByTag resolvedBy={incident.resolvedBy} /> : null}
        <StatusPill status={incident.status} />
      </div>
    </div>
  );
}
