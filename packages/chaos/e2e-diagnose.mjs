// Diagnose the incidents currently in the database with Gemini on Vertex,
// authenticated by Application Default Credentials. No API key involved.
import { readFileSync } from 'node:fs';
import { createDb, listIncidents, saveIncident } from '../store/dist/index.js';
import { Diagnostician, VertexGemini } from '../diagnostician/dist/index.js';

const env = Object.fromEntries(
  readFileSync('/project/blackbox/.env.local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const DB = 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const PROJECT = env.GOOGLE_CLOUD_PROJECT ?? 'somniaforge-unified';
const { db, close } = createDb(DB);

const llm = new VertexGemini({ projectId: PROJECT, model: env.GEMINI_MODEL ?? 'gemini-2.5-flash' });
const diagnostician = new Diagnostician({
  llm,
  logger: { info: () => {}, error: (m, d) => console.log('  [dx]', m, d?.error?.message?.slice(0, 160) ?? '') },
});

const rows = await listIncidents(db, { limit: 5 });
if (rows.length === 0) {
  console.log('no incidents to diagnose — run e2e-c4.mjs or e2e-c2.mjs first');
  await close();
  process.exit(1);
}

console.log(`project ${PROJECT} · model ${llm.modelId} · ${rows.length} incident(s)\n`);

for (const row of rows) {
  const incident = {
    id: row.id,
    class: row.class,
    severity: row.severity,
    status: row.status,
    agentId: row.agentId,
    signer: row.signer,
    chainId: row.chainId,
    detectedAt: row.detectedAt,
    firstEventAt: row.firstEventAt,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
    confidence: row.confidence,
    evidence: row.evidence,
    ...(row.remediation ? { remediation: row.remediation } : {}),
  };

  const started = Date.now();
  const { rca, source, fallbackReason } = await diagnostician.diagnose(incident);
  const ms = Date.now() - started;

  console.log('='.repeat(78));
  console.log(`${incident.class}  [${incident.severity}]  rule ${incident.evidence.ruleId}  ${incident.id}`);
  console.log(`source: ${source}${fallbackReason ? ` (${fallbackReason})` : ''}  ·  ${ms}ms  ·  model ${rca.model}`);
  console.log('\nSUMMARY\n' + rca.summary);
  console.log('\nCONTRIBUTING FACTORS');
  for (const f of rca.contributingFactors) console.log('  - ' + f);
  console.log('\nTIMELINE');
  for (const t of rca.timeline) console.log(`  ${new Date(t.at).toISOString()}  ${t.what}`);
  console.log('\nRECOMMENDATION\n' + rca.recommendation + '\n');

  await saveIncident(db, { ...row, rca });
}

console.log('='.repeat(78));
console.log('written back to the incidents table');
await close();
