import type { ChainConfig, IncidentClass, IncidentStatus, Severity } from '../../lib/types';
import { INCIDENT_CLASSES, INCIDENT_STATUSES, SEVERITIES } from '../../lib/types';
import type { TimelineSearch, TimelineSearchPatch } from '../../routes/timeline';

/**
 * Filters live in the URL, not in component state, so a filtered view can be
 * pasted to someone else and be the same view when they open it.
 */

export function activeFilterCount(search: TimelineSearch): number {
  return [search.class, search.severity, search.status, search.agentId, search.chainId].filter(
    (value) => value !== undefined && value !== '',
  ).length;
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: readonly T[];
  onChange: (next: T | undefined) => void;
}): React.JSX.Element {
  return (
    <label className="filter">
      <span className="filter__label">{label}</span>
      <select
        className="filter__control"
        value={value ?? ''}
        onChange={(event) => onChange((event.target.value || undefined) as T | undefined)}
      >
        <option value="">any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Filters({
  search,
  chains,
  onChange,
  onClear,
}: {
  search: TimelineSearch;
  chains: ChainConfig[];
  onChange: (patch: TimelineSearchPatch) => void;
  onClear: () => void;
}): React.JSX.Element {
  const active = activeFilterCount(search);

  return (
    <div className="filters">
      <Select<Severity>
        label="Severity"
        value={search.severity}
        options={SEVERITIES}
        onChange={(severity) => onChange({ severity })}
      />
      <Select<IncidentClass>
        label="Class"
        value={search.class}
        options={INCIDENT_CLASSES}
        onChange={(next) => onChange({ class: next })}
      />
      <Select<IncidentStatus>
        label="Status"
        value={search.status}
        options={INCIDENT_STATUSES}
        onChange={(status) => onChange({ status })}
      />

      <label className="filter">
        <span className="filter__label">Chain</span>
        <select
          className="filter__control"
          value={search.chainId ?? ''}
          onChange={(event) =>
            onChange({
              chainId: event.target.value ? Number(event.target.value) : undefined,
            })
          }
        >
          <option value="">any</option>
          {chains.map((chain) => (
            <option key={chain.chainId} value={chain.chainId}>
              {chain.name}
            </option>
          ))}
        </select>
      </label>

      <label className="filter">
        <span className="filter__label">Agent</span>
        <input
          className="filter__control"
          type="text"
          placeholder="any"
          value={search.agentId ?? ''}
          onChange={(event) => onChange({ agentId: event.target.value || undefined })}
        />
      </label>

      <span className="filters__gap" />

      {active > 0 ? (
        <button type="button" className="filters__clear" onClick={onClear}>
          clear {active} filter{active === 1 ? '' : 's'}
        </button>
      ) : null}
    </div>
  );
}
