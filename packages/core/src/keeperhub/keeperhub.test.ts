import { describe, expect, it } from 'vitest';
import { keeperHubExecutionSchema } from './types.js';



describe('submission responses', () => {
  it('parses the response to a submission, which omits createdAt', () => {
    // Verbatim from a live POST /api/execute/contract-call that paused a
    // circuit breaker. Requiring createdAt made the client throw *after* the
    // transaction had landed, so the remediation was recorded as failed and
    // the hash was lost.
    const parsed = keeperHubExecutionSchema.parse({
      executionId: 'cyu427kvqh3uc0o22q9zk',
      status: 'completed',
      transactionHash: '0x02652c68f74154767450592f658b95c995439d3ce6c7908b55ab687b434f9861',
      transactionLink: 'https://sepolia.etherscan.io/tx/0x02652c68',
    });
    expect(parsed.executionId).toBe('cyu427kvqh3uc0o22q9zk');
    expect(parsed.createdAt).toBeUndefined();
  });
});

