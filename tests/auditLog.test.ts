import { describe, expect, it } from 'vitest';
import { appendAudit, createAuditLog } from '../src/server/auditLog';
import { mockUser } from '../src/server/authService';

describe('audit log', () => {
  it('appends events and redacts sensitive token-like material', () => {
    const log = createAuditLog();
    const event = appendAudit(
      log,
      mockUser,
      'session.prompt',
      'mock-roadex',
      'allowed',
      'Bearer roadex-demo-token and sk-projectsecret were supplied',
    );

    expect(log.events).toEqual([event]);
    expect(event.summary).not.toContain('roadex-demo-token');
    expect(event.summary).not.toContain('sk-projectsecret');
  });
});
