import type { ProvisioningIntentV1 } from '../src/server/approvalWorkflowMcp';

export function validProvisioningIntent(
  overrides: Partial<ProvisioningIntentV1> = {},
): ProvisioningIntentV1 {
  return {
    schema_version: '1',
    request_id: 'request.roadex.test',
    plan_id: 'plan.roadex.test',
    kind: 'donuthole_encrypted_backup_provisioning_v1',
    project_id: 'roadex',
    resource_id: 'resource-1',
    root_id: 'root.donuthole',
    policy_revision: 'policy.v1',
    source_commit: 'a'.repeat(40),
    requested_by: 'roadex-test',
    reason: 'Run the approved provisioning workflow fixture.',
    supersedes_plan_id: '',
    ...overrides,
  };
}
