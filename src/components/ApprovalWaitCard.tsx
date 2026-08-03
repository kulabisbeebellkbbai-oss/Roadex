import type { WaitingApprovalSummary } from '../shared/approvalWorkflowContracts';
import {
  approvalWaitBodyCopy,
  approvalWaitStatusCopy,
  safeApprovalConsolePath,
} from './approvalWait';

export function ApprovalWaitCard({ wait }: { wait: WaitingApprovalSummary }) {
  const consoleLabel = wait.consoleSurface === 'admin' ? 'Admin Console' : 'Overview Console';
  const consolePath = safeApprovalConsolePath(wait.consoleSurface, wait.consolePath);
  const bodyCopy = approvalWaitBodyCopy(wait);

  return (
    <section
      aria-label="Human approval required"
      className={`approval-wait ${wait.state}`}
      role="status"
    >
      <div className="approval-wait-heading">
        <div>
          <span className="section-label">Human approval required</span>
          <strong>This thread is safely paused.</strong>
        </div>
        <span className="approval-wait-state">{approvalWaitStatusCopy(wait.state)}</span>
      </div>
      <p>{bodyCopy.primary}</p>
      <p>{bodyCopy.secondary}</p>
      <div className="approval-wait-action">
        <code>{wait.approvalRef}</code>
        {consolePath ? <a href={consolePath}>Open {consoleLabel}</a> : null}
      </div>
    </section>
  );
}
