import type { AuditEvent, UserProfile } from '../shared/sessionContracts.js';

export type AuditLog = {
  events: AuditEvent[];
};

export function createAuditLog(): AuditLog {
  return {
    events: [],
  };
}

export function appendAudit(
  log: AuditLog,
  user: UserProfile,
  action: AuditEvent['action'],
  resource: string,
  outcome: AuditEvent['outcome'],
  summary: string,
): AuditEvent {
  const event: AuditEvent = {
    id: `audit-${log.events.length + 1}`,
    at: new Date().toISOString(),
    actorId: user.id,
    action,
    resource,
    outcome,
    summary: redactAuditSummary(summary),
  };
  log.events.push(event);
  return event;
}

export function redactAuditSummary(summary: string): string {
  return summary
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted-openai-key]');
}
