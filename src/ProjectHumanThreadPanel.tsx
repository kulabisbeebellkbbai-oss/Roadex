import { FormEvent, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, History, Link2, Plus, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import {
  getProjectHumanThread,
  getProjectHumanThreadHistory,
  mutateProjectHumanThread,
  type ProjectHumanThreadCandidatePublic,
} from './client/sessionApi';
import type { ProjectHumanThreadBinding } from './shared/projectHumanThreadContracts';
import type { WorkspaceRef } from './shared/sessionContracts';

export type ProjectHumanThreadSnapshot = {
  current?: ProjectHumanThreadBinding;
  candidates: ProjectHumanThreadCandidatePublic[];
  history: Array<Omit<ProjectHumanThreadBinding, 'root' | 'provenanceDigest'>>;
};

type ProjectHumanThreadPanelProps = {
  token?: string;
  project?: WorkspaceRef;
};

type ProjectHumanThreadPanelViewProps = {
  project: WorkspaceRef;
  snapshot: ProjectHumanThreadSnapshot;
  loading: boolean;
  busyAction?: 'create' | 'adopt' | 'recover' | 'replace';
  error?: string;
  replaceOpen: boolean;
  replaceReason: string;
  onRefresh: () => void;
  onCreate: () => void;
  onAdopt: (conversationId: string) => void;
  onRecover: () => void;
  onReplaceOpen: (open: boolean) => void;
  onReplaceReason: (reason: string) => void;
  onReplace: (event: FormEvent<HTMLFormElement>) => void;
};

const emptySnapshot: ProjectHumanThreadSnapshot = { candidates: [], history: [] };

export function ProjectHumanThreadPanel({ token, project }: ProjectHumanThreadPanelProps) {
  const [snapshot, setSnapshot] = useState<ProjectHumanThreadSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<ProjectHumanThreadPanelViewProps['busyAction']>();
  const [error, setError] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceReason, setReplaceReason] = useState('');
  const idempotencyKeys = useRef(new Map<string, string>());

  async function refresh(): Promise<void> {
    if (!project) return;
    setLoading(true);
    setError('');
    try {
      const [thread, history] = await Promise.all([
        getProjectHumanThread(token, project.id),
        getProjectHumanThreadHistory(token, project.id),
      ]);
      setSnapshot({ current: thread.current, candidates: thread.candidates, history });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Project human thread status could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSnapshot(emptySnapshot);
    setReplaceOpen(false);
    setReplaceReason('');
    void refresh();
  // refresh intentionally tracks project identity and token only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, token]);

  async function mutate(action: 'create' | 'adopt' | 'recover' | 'replace', body: Record<string, unknown>): Promise<void> {
    if (!project) return;
    setBusyAction(action);
    setError('');
    const requestSignature = `${action}:${JSON.stringify(body)}`;
    const idempotencyKey = idempotencyKeys.current.get(requestSignature) ?? makeIdempotencyKey(action);
    idempotencyKeys.current.set(requestSignature, idempotencyKey);
    try {
      await mutateProjectHumanThread(token, project.id, action, idempotencyKey, body);
      idempotencyKeys.current.delete(requestSignature);
      setReplaceOpen(false);
      setReplaceReason('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Project human thread ${action} failed.`);
    } finally {
      setBusyAction(undefined);
    }
  }

  if (!project) return null;
  return (
    <ProjectHumanThreadPanelView
      project={project}
      snapshot={snapshot}
      loading={loading}
      busyAction={busyAction}
      error={error}
      replaceOpen={replaceOpen}
      replaceReason={replaceReason}
      onRefresh={() => void refresh()}
      onCreate={() => void mutate('create', {})}
      onAdopt={(conversationId) => void mutate('adopt', { conversationId })}
      onRecover={() => snapshot.current && void mutate('recover', { expectedGeneration: snapshot.current.generation })}
      onReplaceOpen={setReplaceOpen}
      onReplaceReason={setReplaceReason}
      onReplace={(event) => {
        event.preventDefault();
        if (snapshot.current && replaceReason.trim()) {
          void mutate('replace', { expectedGeneration: snapshot.current.generation, reason: replaceReason.trim() });
        }
      }}
    />
  );
}

export function ProjectHumanThreadPanelView({
  project,
  snapshot,
  loading,
  busyAction,
  error,
  replaceOpen,
  replaceReason,
  onRefresh,
  onCreate,
  onAdopt,
  onRecover,
  onReplaceOpen,
  onReplaceReason,
  onReplace,
}: ProjectHumanThreadPanelViewProps) {
  const current = snapshot.current;
  const hasBinding = Boolean(current);
  const canReplace = Boolean(current) && !busyAction;
  return (
    <section className="section-card human-thread-panel" aria-label="Project Roadex human interaction thread" data-testid="project-human-thread-panel">
      <div className="panel-heading compact human-thread-heading">
        <div>
          <span className="section-label">Roadex human interaction</span>
          <h2>Project thread</h2>
        </div>
        <div className="human-thread-heading-actions">
          <span className="human-thread-project">{project.name}</span>
          <button aria-label="Refresh project human thread" className="icon-action" disabled={loading || Boolean(busyAction)} onClick={onRefresh} title="Refresh project human thread" type="button">
            <RefreshCw size={17} />
          </button>
        </div>
      </div>

      <p className="human-thread-separation">
        This dedicated Roadex thread is the human conversation for this project. Overseer approvals remain a separate authority surface.
      </p>

      {error ? (
        <div className="human-thread-alert" role="alert"><AlertTriangle size={18} /><span>{error}</span></div>
      ) : null}

      {loading && !hasBinding ? <p className="human-thread-loading" role="status">Checking the project thread binding…</p> : null}

      {current ? (
        <div className={`human-thread-status human-thread-status-${current.status}`} data-testid="project-human-thread-current">
          <div className="human-thread-status-title">
            <div>
              <span className="section-label">Current binding</span>
              <strong>{statusLabel(current.status)}</strong>
            </div>
            <span className="human-thread-generation">Generation {current.generation}</span>
          </div>
          <dl className="human-thread-details">
            <div><dt>Conversation</dt><dd><Link2 size={14} /> <code>{current.conversationId}</code></dd></div>
            <div><dt>Purpose</dt><dd>{current.purpose}</dd></div>
            <div><dt>Created</dt><dd>{formatTimestamp(current.createdAt)}</dd></div>
            <div><dt>Binding mode</dt><dd>{current.creationMode}</dd></div>
          </dl>
          <div className="human-thread-actions">
            {current.status === 'unavailable' ? (
              <button className="secondary-action" disabled={Boolean(busyAction)} onClick={onRecover} type="button">
                <RotateCcw size={16} /> {busyAction === 'recover' ? 'Recovering…' : 'Recover thread'}
              </button>
            ) : null}
            <button className="secondary-action" disabled={!canReplace} onClick={() => onReplaceOpen(!replaceOpen)} type="button">
              <RefreshCw size={16} /> Replace binding
            </button>
          </div>
        </div>
      ) : snapshot.candidates.length ? (
        <div className="human-thread-missing" data-testid="project-human-thread-candidates">
          <div className="human-thread-status-title">
            <div>
              <span className="section-label">Binding missing</span>
              <strong>Adoption required</strong>
            </div>
            <span className="human-thread-badge">{snapshot.candidates.length} candidate{snapshot.candidates.length === 1 ? '' : 's'}</span>
          </div>
          <p>Roadex found existing Codex conversations for this project. Choose exactly one to make it the dedicated human-interaction thread.</p>
          <div className="human-thread-candidates">
            {snapshot.candidates.map((candidate) => (
              <div className="human-thread-candidate" key={candidate.conversationId}>
                <div><code>{candidate.conversationId}</code><span>{formatCandidateDate(candidate.createdAt)}</span></div>
                <button className="secondary-action" disabled={Boolean(busyAction)} onClick={() => onAdopt(candidate.conversationId)} type="button">
                  <CheckCircle2 size={16} /> {busyAction === 'adopt' ? 'Adopting…' : 'Adopt as project thread'}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="human-thread-missing" data-testid="project-human-thread-missing">
          <div className="human-thread-status-title">
            <div>
              <span className="section-label">Binding missing</span>
              <strong>No project thread is bound</strong>
            </div>
            <span className="human-thread-badge">Generation 0</span>
          </div>
          <p>Create the single dedicated Roadex conversation for {project.name}. This does not approve or deploy anything.</p>
          <button className="primary-action" disabled={Boolean(busyAction)} onClick={onCreate} type="button">
            <Plus size={17} /> {busyAction === 'create' ? 'Creating…' : 'Create project thread'}
          </button>
        </div>
      )}

      {replaceOpen && current ? (
        <form className="human-thread-replace" onSubmit={onReplace}>
          <div>
            <span className="section-label">Controlled replacement</span>
            <strong>Replace generation {current.generation}</strong>
          </div>
          <p>The predecessor remains visible in the read-only history. Provide the reason for creating the next generation.</p>
          <label>
            <span>Replacement reason</span>
            <textarea aria-label="Replacement reason" maxLength={1_000} minLength={1} onChange={(event) => onReplaceReason(event.target.value)} placeholder="Explain why the current project thread cannot continue." required value={replaceReason} />
          </label>
          <div className="human-thread-actions">
            <button className="secondary-action" onClick={() => onReplaceOpen(false)} type="button">Cancel</button>
            <button className="primary-action" disabled={!replaceReason.trim() || busyAction === 'replace'} type="submit">
              <RefreshCw size={16} /> {busyAction === 'replace' ? 'Replacing…' : 'Confirm replacement'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="human-thread-history" data-testid="project-human-thread-history">
        <div className="human-thread-history-heading">
          <div><History size={17} /><strong>Predecessor history</strong></div>
          <span>Read-only</span>
        </div>
        {snapshot.history.length ? (
          <ol>
            {snapshot.history.map((binding) => (
              <li key={binding.bindingId} className={binding.status === 'active' ? 'current' : ''}>
                <div><strong>Generation {binding.generation}</strong><span>{statusLabel(binding.status)}</span></div>
                <code>{binding.conversationId}</code>
                <small>{binding.creationMode} · {formatTimestamp(binding.createdAt)}</small>
              </li>
            ))}
          </ol>
        ) : <p>No predecessor generations recorded.</p>}
      </div>

      <div className="human-thread-note"><ShieldCheck size={16} /><span>Only the project binding lifecycle is available here. Overseer approvals are never created or changed by this panel.</span></div>
    </section>
  );
}

function statusLabel(status: ProjectHumanThreadBinding['status']): string {
  return status.replace('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatCandidateDate(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown creation time' : `Created ${date.toLocaleString()}`;
}

function makeIdempotencyKey(action: string): string {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `project-human-thread-${action}-${random}`;
}
