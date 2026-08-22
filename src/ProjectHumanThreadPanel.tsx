import { FormEvent, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, History, Link2, MessageSquare, Plus, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import {
  getProjectHumanThread,
  getProjectHumanThreadHistory,
  mutateProjectHumanThread,
  reconcileProjectHumanThread,
  resumeProjectHumanThread,
  type ProjectHumanThreadCandidatePublic,
  type ProjectHumanThreadReplacementPublic,
} from './client/sessionApi';
import {
  getProjectHumanThreadTranscript,
  submitProjectHumanThreadResponse,
  type ProjectHumanThreadPublicQuestion,
} from './client/projectHumanThreadTranscriptApi';
import type { ProjectHumanThreadBinding } from './shared/projectHumanThreadContracts';
import type { WorkspaceRef } from './shared/sessionContracts';

export type ProjectHumanThreadSnapshot = {
  current?: ProjectHumanThreadBinding;
  candidates: ProjectHumanThreadCandidatePublic[];
  history: Array<Omit<ProjectHumanThreadBinding, 'root' | 'provenanceDigest'>>;
  replacement?: ProjectHumanThreadReplacementPublic;
};

type ProjectHumanThreadPanelProps = {
  token?: string;
  project?: WorkspaceRef;
  onOpenConversation?: (conversationId: string) => void;
};

type ProjectHumanThreadPanelViewProps = {
  project: WorkspaceRef;
  snapshot: ProjectHumanThreadSnapshot;
  loading: boolean;
  busyAction?: 'create' | 'adopt' | 'recover' | 'replace' | 'resume' | 'reconcile';
  error?: string;
  replaceOpen: boolean;
  replaceReason: string;
  onRefresh: () => void;
  onCreate: () => void;
  onAdopt: (conversationId: string) => void;
  onRecover: () => void;
  onResume: () => void;
  onReconcile: (conversationId: string) => void;
  onReplaceOpen: (open: boolean) => void;
  onReplaceReason: (reason: string) => void;
  onReplace: (event: FormEvent<HTMLFormElement>) => void;
  pendingQuestions?: ProjectHumanThreadPublicQuestion[];
  transcriptHistory?: ProjectHumanThreadPublicQuestion[];
  responseDrafts?: Record<string, string>;
  respondingMessageId?: string;
  transcriptError?: string;
  onResponseDraft?: (messageId: string, content: string) => void;
  onRespond?: (messageId: string, content: string) => void;
  onOpenConversation?: (conversationId: string) => void;
};

const emptySnapshot: ProjectHumanThreadSnapshot = { candidates: [], history: [] };

export function ProjectHumanThreadPanel({ token, project, onOpenConversation }: ProjectHumanThreadPanelProps) {
  const [snapshot, setSnapshot] = useState<ProjectHumanThreadSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<ProjectHumanThreadPanelViewProps['busyAction']>();
  const [error, setError] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceReason, setReplaceReason] = useState('');
  const idempotencyKeys = useRef(new Map<string, string>());
  const [pendingQuestions, setPendingQuestions] = useState<ProjectHumanThreadPublicQuestion[]>([]);
  const [transcriptHistory, setTranscriptHistory] = useState<ProjectHumanThreadPublicQuestion[]>([]);
  const [transcriptError, setTranscriptError] = useState('');
  const [responseDrafts, setResponseDrafts] = useState<Record<string, string>>({});
  const [respondingMessageId, setRespondingMessageId] = useState('');

  async function refreshTranscript(): Promise<void> {
    if (!project) return;
    try {
      const [pending, history] = await Promise.all([
        getProjectHumanThreadTranscript(token, project.id, 'pending'),
        getProjectHumanThreadTranscript(token, project.id, 'history'),
      ]);
      setPendingQuestions(pending);
      setTranscriptHistory(history);
      setTranscriptError('');
    } catch (cause) {
      setTranscriptError(cause instanceof Error ? cause.message : 'Project conversation could not be loaded.');
    }
  }

  async function refresh(): Promise<void> {
    if (!project) return;
    setLoading(true);
    setError('');
    try {
      const [thread, history] = await Promise.all([
        getProjectHumanThread(token, project.id),
        getProjectHumanThreadHistory(token, project.id),
      ]);
      setSnapshot({ current: thread.current, candidates: thread.candidates, history, replacement: thread.replacement });
      await refreshTranscript();
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
    setPendingQuestions([]);
    setTranscriptHistory([]);
    setTranscriptError('');
    void refresh();
  // refresh intentionally tracks project identity and token only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, token]);

  async function mutate(action: 'create' | 'adopt' | 'recover' | 'replace' | 'resume' | 'reconcile', body: Record<string, unknown>): Promise<void> {
    if (!project) return;
    setBusyAction(action);
    setError('');
    try {
      let result: unknown;
      if (action === 'resume') {
        result = await resumeProjectHumanThread(token, project.id, Number(body.expectedGeneration));
      } else if (action === 'reconcile') {
        result = await reconcileProjectHumanThread(token, project.id, Number(body.expectedGeneration), String(body.conversationId));
      } else {
        const requestSignature = `${action}:${JSON.stringify(body)}`;
        const idempotencyKey = idempotencyKeys.current.get(requestSignature) ?? makeIdempotencyKey(action);
        idempotencyKeys.current.set(requestSignature, idempotencyKey);
        result = await mutateProjectHumanThread(token, project.id, action, idempotencyKey, body);
        idempotencyKeys.current.delete(requestSignature);
      }
      if (isReconciliationResult(result)) {
        setError('Reconciliation is required. Select one exact unbound candidate, or retry Resume after the authority becomes inspectable.');
        await refresh();
        return;
      }
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
      onResume={() => snapshot.current && void mutate('resume', { expectedGeneration: snapshot.current.generation })}
      onReconcile={(conversationId) => snapshot.current && void mutate('reconcile', { expectedGeneration: snapshot.current.generation, conversationId })}
      onReplaceOpen={setReplaceOpen}
      onReplaceReason={setReplaceReason}
      onReplace={(event) => {
        event.preventDefault();
        if (snapshot.current && replaceReason.trim()) {
          void mutate('replace', { expectedGeneration: snapshot.current.generation, reason: replaceReason.trim() });
        }
      }}
      pendingQuestions={pendingQuestions}
      transcriptHistory={transcriptHistory}
      responseDrafts={responseDrafts}
      respondingMessageId={respondingMessageId}
      transcriptError={transcriptError}
      onResponseDraft={(messageId, content) => setResponseDrafts((current) => ({ ...current, [messageId]: content }))}
      onRespond={(messageId, content) => {
        if (!project || !content.trim()) return;
        setRespondingMessageId(messageId);
        void submitProjectHumanThreadResponse(token, project.id, messageId, content.trim(), makeIdempotencyKey('respond'))
          .then(() => {
            setResponseDrafts((current) => ({ ...current, [messageId]: '' }));
            return refreshTranscript();
          })
          .catch((cause) => setTranscriptError(cause instanceof Error ? cause.message : 'Project response could not be submitted.'))
          .finally(() => setRespondingMessageId(''));
      }}
      onOpenConversation={onOpenConversation}
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
  onResume,
  onReconcile,
  onReplaceOpen,
  onReplaceReason,
  onReplace,
  pendingQuestions = [],
  transcriptHistory = [],
  responseDrafts = {},
  respondingMessageId = '',
  transcriptError,
  onResponseDraft,
  onRespond,
  onOpenConversation,
}: ProjectHumanThreadPanelViewProps) {
  const current = snapshot.current;
  const hasBinding = Boolean(current);
  const canReplace = Boolean(current) && current?.status !== 'replacement-pending' && !busyAction;
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
            {onOpenConversation ? (
              <button className="secondary-action" disabled={current.status !== 'active'} onClick={() => onOpenConversation(current.conversationId)} type="button">
                <Link2 size={16} /> Open project conversation
              </button>
            ) : null}
            {current.status === 'unavailable' ? (
              <button className="secondary-action" disabled={Boolean(busyAction)} onClick={onRecover} type="button">
                <RotateCcw size={16} /> {busyAction === 'recover' ? 'Recovering…' : 'Recover thread'}
              </button>
            ) : null}
            {current.status === 'replacement-pending' ? (
              <div className="human-thread-pending-note" data-testid="project-human-thread-replacement-pending">
                {snapshot.replacement ? (
                  <>
                    <p>Replacement is pending ({snapshot.replacement.createPhase}). Resume uses the durable server-side request; a new replacement request is rejected.</p>
                    <div className="human-thread-actions">
                      <button className="primary-action" disabled={Boolean(busyAction)} onClick={onResume} type="button">
                        <RotateCcw size={16} /> {busyAction === 'resume' ? 'Resuming…' : 'Resume replacement'}
                      </button>
                    </div>
                  </>
                ) : <p>Replacement is pending without a recoverable intent. Select an exact unbound candidate below for manual reconciliation; a new replacement request is blocked.</p>}
                {snapshot.candidates.length ? (
                  <div className="human-thread-candidates" data-testid="project-human-thread-reconcile-candidates">
                    <span className="section-label">Reconcile an exact candidate</span>
                    {snapshot.candidates.map((candidate) => (
                      <div className="human-thread-candidate" key={candidate.conversationId}>
                        <code>{candidate.conversationId}</code>
                        <button className="secondary-action" disabled={Boolean(busyAction)} onClick={() => onReconcile(candidate.conversationId)} type="button">
                          <CheckCircle2 size={16} /> {busyAction === 'reconcile' ? 'Reconciling…' : 'Reconcile candidate'}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
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

      <section className="human-thread-inbox" aria-label="Project conversation" data-testid="project-human-thread-inbox">
        <div className="human-thread-history-heading">
          <div><MessageSquare size={17} /><strong>Project conversation</strong></div>
          <span>{pendingQuestions.length ? `${pendingQuestions.length} pending` : 'No pending questions'}</span>
        </div>
        {transcriptError ? <p className="human-thread-transcript-error" role="alert">{transcriptError}</p> : null}
        {pendingQuestions.length ? pendingQuestions.map((question) => (
          <PendingQuestion
            key={question.messageId}
            question={question}
            draft={responseDrafts[question.messageId] ?? ''}
            responding={respondingMessageId === question.messageId}
            onDraft={onResponseDraft}
            onRespond={onRespond}
          />
        )) : <p>No new project questions are waiting for your response.</p>}
        {transcriptHistory.some((question) => question.state === 'answered') ? (
          <details className="human-thread-conversation-history">
            <summary>Answered conversation history ({transcriptHistory.filter((question) => question.state === 'answered').length})</summary>
            <ol>
              {transcriptHistory.filter((question) => question.state === 'answered').map((question) => (
                <li key={question.messageId}>
                  <strong>{question.content}</strong>
                  <span>{question.kind === 'informational-notice' ? 'Notice acknowledged — no response requested.' : question.response?.content ?? 'Answered'}</span>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </section>

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

function PendingQuestion({
  question,
  draft,
  responding,
  onDraft,
  onRespond,
}: {
  question: ProjectHumanThreadPublicQuestion;
  draft: string;
  responding: boolean;
  onDraft?: (messageId: string, content: string) => void;
  onRespond?: (messageId: string, content: string) => void;
}) {
  const isInformational = question.kind === 'informational-notice';
  return (
    <article className="human-thread-question" data-testid={`project-human-thread-question-${question.messageId}`}>
      <div className="human-thread-question-content">
        <span className="section-label">{question.kind === 'bounded-choice' ? 'Choice requested' : isInformational ? 'Notice' : 'Question'}</span>
        <p>{question.content}</p>
      </div>
      {question.kind === 'bounded-choice' ? (
        <div className="human-thread-choice-list" role="group" aria-label="Response choices">
          {question.choices.map((choice) => (
            <button className="secondary-action" disabled={responding} key={choice} onClick={() => onRespond?.(question.messageId, choice)} type="button">{choice}</button>
          ))}
        </div>
      ) : isInformational ? (
        <span className="human-thread-no-response">Informational notice — no response is requested.</span>
      ) : (
        <form className="human-thread-response-form" onSubmit={(event) => { event.preventDefault(); onRespond?.(question.messageId, draft); }}>
          <label><span>Your response</span><textarea aria-label={`Response to ${question.content}`} onChange={(event) => onDraft?.(question.messageId, event.target.value)} value={draft} /></label>
          <button className="primary-action" disabled={!draft.trim() || responding} type="submit">{responding ? 'Sending…' : 'Send response'}</button>
        </form>
      )}
    </article>
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

function isReconciliationResult(value: unknown): value is { outcome: 'reconciliation-required'; candidates: unknown[] } {
  return Boolean(value && typeof value === 'object' && (value as { outcome?: unknown }).outcome === 'reconciliation-required');
}
