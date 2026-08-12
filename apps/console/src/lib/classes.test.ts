import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INCIDENT_CLASSES } from './types';

/**
 * The console cannot import `@blackbox/core` — it would pull zod and viem into
 * a browser bundle for the sake of a string list — so the list is duplicated
 * here and this test is what keeps the copy honest.
 *
 * It is not hypothetical. Three classes (EXECUTION_STALLED,
 * WORKFLOW_MISCONFIGURED, SPEND_CAP_EXHAUSTED) were added to the detector and
 * never to the console, so the timeline could not filter for incidents the
 * deployment was actively raising and their evidence rendered as "unknown".
 */
const SCHEMAS = fileURLToPath(
  new URL('../../../../packages/core/src/schemas.ts', import.meta.url),
);

/** The members of `incidentClass`, read out of the enum's own source. */
function classesFromCore(): string[] {
  const source = readFileSync(SCHEMAS, 'utf8');
  const start = source.indexOf('export const incidentClass = z.enum([');
  expect(start, 'incidentClass has been renamed or moved').toBeGreaterThan(-1);
  const end = source.indexOf(']);', start);
  return [...source.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string);
}

describe('the class list', () => {
  it('is exactly the one the rules can produce, in the same order', () => {
    expect(INCIDENT_CLASSES).toEqual(classesFromCore());
  });
});
