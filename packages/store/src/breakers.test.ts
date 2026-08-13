import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, agentBreakers, breakerFor, registerBreaker, removeBreaker, breakersForOrg, type Database } from './index.js';

const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
let db: Database; let close: () => Promise<void>;
const AT = new Date('2026-08-14T10:00:00Z');

beforeAll(() => { ({ db, close } = createDb(URL)); });
afterAll(async () => { await close(); });
beforeEach(async () => { await db.delete(agentBreakers); });

describe('the breaker an agent may have', () => {
  it('is absent until somebody registers one', async () => {
    expect(await breakerFor(db, 'kh:wf-1')).toBeNull();
  });

  it('is found by the agent id a connected workflow actually uses', async () => {
    // The bug this table exists to fix: the lookup was keyed to the literal
    // id "chaos", so kh:<workflowId> could never match.
    await registerBreaker(db, {
      agentId: 'kh:dylvomthaaou2yvn9yop4',
      address: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0',
      chainId: 11155111, orgId: 'org-1', at: AT,
    });
    const row = await breakerFor(db, 'kh:dylvomthaaou2yvn9yop4');
    expect(row?.address).toBe('0x69c744bb9f953d822a52e88604d26c9a895ac0e0');
    expect(row?.chainId).toBe(11155111);
    expect(row?.verifiedAt).toBeNull();
  });

  it('is replaced rather than duplicated when re-registered', async () => {
    await registerBreaker(db, { agentId: 'a', address: '0xaaa', chainId: 1, orgId: 'org-1', at: AT });
    await registerBreaker(db, { agentId: 'a', address: '0xbbb', chainId: 1, orgId: 'org-1', at: AT, verifiedAt: AT });
    expect((await breakerFor(db, 'a'))?.address).toBe('0xbbb');
    expect((await breakerFor(db, 'a'))?.verifiedAt).toEqual(AT);
    expect(await breakersForOrg(db, 'org-1')).toHaveLength(1);
  });

  it('lists only an organisation own, and forgets one on removal', async () => {
    await registerBreaker(db, { agentId: 'a', address: '0xaaa', chainId: 1, orgId: 'mine', at: AT });
    await registerBreaker(db, { agentId: 'b', address: '0xbbb', chainId: 1, orgId: 'theirs', at: AT });
    expect(await breakersForOrg(db, 'mine')).toHaveLength(1);
    await removeBreaker(db, 'a');
    expect(await breakerFor(db, 'a')).toBeNull();
  });
});
