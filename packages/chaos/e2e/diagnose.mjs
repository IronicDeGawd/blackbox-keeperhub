// Diagnose whatever incidents are in the database with Gemini on Vertex,
// authenticated by Application Default Credentials. No API key involved.
// Writes each analysis back onto its incident.
import { listIncidents, saveIncident } from '../../store/dist/index.js';
import { Diagnostician, VertexGemini } from '../../diagnostician/dist/index.js';
import { setup, env } from './harness.mjs';

const { db, close } = await setup();

const PROJECT = env.GOOGLE_CLOUD_PROJECT ?? 'somniaforge-unified';
const llm = new VertexGemini({
  projectId: PROJECT,
  ...(env.GEMINI_MODEL ? { model: env.GEMINI_MODEL } : {}),
});
const diagnostician = new Diagnostician({
  llm,
  logger: {
    info: () => {},
    error: (m, d) => console.log('  [dx]', m, d?.error?.message?.slice(0, 160) ?? ''),
  },
});

const rows = await listIncidents(db, { limit: 5 });
if (rows.length === 0) {
  console.log('\nno incidents to diagnose — run c4-retry-storm.mjs or c2-nonce-gap.mjs first');
  await close();
  process.exit(1);
}

console.log(`\nproject ${PROJECT} · model ${llm.modelId} · ${rows.length} incident(s)\n`);

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
  for (const factor of rca.contributingFactors) console.log('  - ' + factor);
  console.log('\nTIMELINE');
  for (const entry of rca.timeline) console.log(`  ${new Date(entry.at).toISOString()}  ${entry.what}`);
  console.log('\nRECOMMENDATION\n' + rca.recommendation + '\n');

  await saveIncident(db, { ...row, rca });
}

console.log('='.repeat(78));
console.log('written back to the incidents table');
await close();
