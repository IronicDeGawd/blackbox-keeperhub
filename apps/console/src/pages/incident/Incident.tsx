import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ApiError, api } from '../../lib/api';
import { chainName } from '../../lib/explorer';
import { absoluteTime, formatConfidence } from '../../lib/format';
import { useConsole } from '../../lib/store';
import type { IncidentDetail } from '../../lib/types';
import { incidentRoute } from '../../routes/incident';
import {
  ClassBadge,
  CopyableAddress,
  RelativeTime,
  ResolvedByTag,
  RuleTag,
  SeverityDot,
  StatusPill,
} from '../../ui/primitives';
import { Actions } from './Actions';
import { Evidence } from './Evidence';
import { EventTimeline } from './EventTimeline';
import { ProposePanel } from './ProposePanel';
import { Rca } from './Rca';
import { Remediation } from './Remediation';
import './incident.css';

/**
 * One incident in full.
 *
 * The page re-reads itself whenever an event names this incident. Watching the
 * filtered list instead would not work: the incident being shown may not be in
 * it at all.
 */
export function Incident(): React.JSX.Element {
  const { id } = incidentRoute.useParams();
  const { config, lastTouched } = useConsole();

  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const loaded = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    // A refetch triggered by an event must not blank a page being read.
    if (!loaded.current) setLoading(true);
    try {
      const next = await api.incident(id);
      setDetail(next);
      setError(null);
      loaded.current = true;
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loaded.current = false;
    void load();
  }, [load]);

  const touchedAt = lastTouched?.id === id ? lastTouched.at : null;
  useEffect(() => {
    if (touchedAt !== null && loaded.current) void load();
  }, [touchedAt, load]);

  if (loading && !detail) {
    return (
      <section className="page">
        <p className="eyebrow eyebrow--accent eyebrow--ruled">Incident</p>
        <div className="panel section skeleton-panel" aria-busy="true" />
      </section>
    );
  }

  if (error && !detail) {
    return (
      <section className="page">
        <p className="eyebrow eyebrow--accent eyebrow--ruled">Incident</p>
        <div className="panel panel--accent state" role="alert">
          <p className="state__lead">Could not load {id}.</p>
          <p className="soft">{error.detail}</p>
          <Link to="/" className="mono">
            ← back to the timeline
          </Link>
        </div>
      </section>
    );
  }

  if (!detail) return <section className="page" />;

  const chains = config?.chains ?? [];

  return (
    <section className="page">
      <header className="incident__head">
        <p className="eyebrow eyebrow--accent eyebrow--ruled">Incident {detail.id}</p>

        <div className="incident__title">
          <SeverityDot severity={detail.severity} />
          <span className={`row__sev row__sev--${detail.severity}`}>{detail.severity}</span>
          <ClassBadge value={detail.class} />
          {/* The server sends ruleId on the detail shape; the mock only puts it
              inside evidence. Read whichever is there. */}
          <RuleTag ruleId={detail.ruleId ?? detail.evidence.ruleId} />
          <span className="section__gap" />
          {detail.resolvedBy ? <ResolvedByTag resolvedBy={detail.resolvedBy} /> : null}
          <StatusPill status={detail.status} />
        </div>

        <p className="incident__summary">{detail.summary}</p>

        <dl className="incident__meta">
          <div>
            <dt>Agent</dt>
            <dd>{detail.agentId}</dd>
          </div>
          <div>
            <dt>Signer</dt>
            <dd>
              <CopyableAddress value={detail.signer} />
            </dd>
          </div>
          <div>
            <dt>Chain</dt>
            <dd>{chainName(chains, detail.chainId)}</dd>
          </div>
          <div>
            <dt>Detected</dt>
            <dd title={absoluteTime(detail.detectedAt)}>
              <RelativeTime at={detail.detectedAt} />
            </dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd title={absoluteTime(detail.lastSeenAt)}>
              <RelativeTime at={detail.lastSeenAt} />
            </dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd className="num">{formatConfidence(detail.confidence)}</dd>
          </div>
        </dl>
      </header>

      <Actions
        incident={detail}
        capabilities={config?.capabilities ?? null}
        chains={chains}
        onChanged={() => void load()}
      />

      <Evidence
        evidence={detail.evidence}
        incidentClass={detail.class}
        confidence={detail.confidence}
      />

      <EventTimeline events={detail.events ?? []} chains={chains} chainId={detail.chainId} />

      <Rca rca={detail.rca} />

      <Remediation
        remediation={detail.remediation}
        chains={chains}
        chainId={detail.chainId}
      />

      {/* Absent unless this process can plan a fix for someone else to sign. */}
      {config?.capabilities.proposeRemediation ? (
        <ProposePanel incidentId={detail.id} chains={chains} />
      ) : null}
    </section>
  );
}
