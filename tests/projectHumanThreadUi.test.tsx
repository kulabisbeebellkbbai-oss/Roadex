import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ProjectHumanThreadPanelView,
  type ProjectHumanThreadSnapshot,
} from '../src/ProjectHumanThreadPanel';
import {
  ProjectHumanThreadRefreshFence,
  projectHumanThreadIdempotencyScope,
} from '../src/client/projectHumanThreadRefreshFence';
import type { ProjectHumanThreadPublicQuestion } from '../src/client/projectHumanThreadTranscriptApi';
import type { ProjectHumanThreadBinding } from '../src/shared/projectHumanThreadContracts';

const project = { id: 'arcade', name: 'Arcade', root: '/srv/projects/arcade' };
const binding = {
  schemaVersion: 'roadex.project-human-thread-binding.v1',
  bindingId: 'project-human-thread:arcade:2',
  projectId: 'arcade',
  root: { canonicalPath: project.root, dev: '1', ino: '2' },
  purpose: 'human-interaction',
  conversationId: '11111111-1111-1111-1111-111111111111',
  generation: 2,
  status: 'active',
  predecessorGeneration: 1,
  creationMode: 'created',
  provenanceDigest: 'a'.repeat(64),
  createdAt: '2026-08-22T12:00:00.000Z',
  updatedAt: '2026-08-22T12:00:00.000Z',
  retiredAt: null,
  recordDigest: 'b'.repeat(64),
} as ProjectHumanThreadBinding;

function snapshot(overrides: Partial<ProjectHumanThreadSnapshot> = {}): ProjectHumanThreadSnapshot {
  return { candidates: [], history: [], ...overrides };
}

function view(overrides: Partial<Parameters<typeof ProjectHumanThreadPanelView>[0]> = {}) {
  return renderToStaticMarkup(
    <ProjectHumanThreadPanelView
      project={project}
      snapshot={snapshot()}
      loading={false}
      lifecycleValidated={true}
      replaceOpen={false}
      replaceReason=""
      onRefresh={vi.fn()}
      onCreate={vi.fn()}
      onAdopt={vi.fn()}
      onRecover={vi.fn()}
      onResume={vi.fn()}
      onReconcile={vi.fn()}
      onReplaceOpen={vi.fn()}
      onReplaceReason={vi.fn()}
      onReplace={vi.fn()}
      {...overrides}
    />,
  );
}

describe('project human thread UI', () => {
  it('rejects a late refresh token after the selected project changes', () => {
    const fence = new ProjectHumanThreadRefreshFence();
    const arcadeIdentity = { id: 'arcade', root: '/srv/projects/arcade', authEpoch: 'token-a' };
    const shadowBrokerIdentity = { id: 'shadowbroker', root: '/srv/projects/shadowbroker', authEpoch: 'token-b' };
    const arcade = fence.beginIfCurrent(arcadeIdentity, arcadeIdentity)!;
    const shadowBroker = fence.beginIfCurrent(shadowBrokerIdentity, shadowBrokerIdentity)!;
    const lateArcade = fence.beginIfCurrent(arcadeIdentity, shadowBrokerIdentity);

    expect(fence.isCurrent(arcade, shadowBrokerIdentity)).toBe(false);
    expect(lateArcade).toBeUndefined();
    expect(fence.isCurrent(shadowBroker, shadowBrokerIdentity)).toBe(true);
  });

  it('keeps idempotency caches distinct across authentication epochs', () => {
    const action = { action: 'replace', body: { expectedGeneration: 1, reason: 'Unavailable' } } as const;
    const first = projectHumanThreadIdempotencyScope('token-a', action.action, action.body);
    const second = projectHumanThreadIdempotencyScope('token-b', action.action, action.body);

    expect(first).not.toBe(second);
    expect(projectHumanThreadIdempotencyScope('token-a', action.action, action.body)).toBe(first);
  });

  it('offers creation when a project has no current binding or candidates', () => {
    const html = view();
    expect(html).toContain('Project thread');
    expect(html).toContain('No project thread is bound');
    expect(html).toContain('Create project thread');
    expect(html).toContain('Overseer approvals remain a separate authority surface.');
    expect(html).toContain('data-testid="project-human-thread-missing"');
  });

  it('keeps the dedicated thread on the project transcript surface instead of ordinary session attach', () => {
    const html = view({ snapshot: snapshot({ current: binding }) });

    expect(html).not.toContain('Open project conversation');
    expect(html).toContain('Questions from the project and your responses stay in this panel');
  });

  it('fails closed without lifecycle actions when thread status is invalid', () => {
    const html = view({ error: 'Project human thread response is invalid.' });

    expect(html).toContain('Project human thread response is invalid.');
    expect(html).toContain('Thread lifecycle controls are unavailable');
    expect(html).not.toContain('Create project thread');
    expect(html).not.toContain('Adopt as project thread');
    expect(html).not.toContain('Recover thread');
    expect(html).not.toContain('Replace binding');
    expect(html).not.toContain('Resume replacement');
  });

  it('keeps stale lifecycle actions fenced while an invalid status refresh is pending', () => {
    const html = view({
      snapshot: snapshot({ current: binding }),
      error: 'Project human thread response is invalid.',
      loading: true,
    });

    expect(html).toContain('Thread lifecycle controls are unavailable');
    expect(html).not.toContain('Open project conversation');
    expect(html).not.toContain('Replace binding');
  });

  it('does not expose creation before the first lifecycle snapshot is validated', () => {
    const html = view({ lifecycleValidated: false, loading: true });

    expect(html).toContain('Checking the project thread binding');
    expect(html).not.toContain('Create project thread');
    expect(html).not.toContain('Adopt as project thread');
    expect(html).not.toContain('Replace binding');
  });

  it('lists candidates and provides explicit adoption actions', () => {
    const html = view({ snapshot: snapshot({ candidates: [{
      conversationId: '22222222-2222-2222-2222-222222222222',
      canonicalPath: project.root,
      dev: '1',
      ino: '2',
      createdAt: Date.parse('2026-08-22T12:00:00.000Z'),
    }] }) });
    expect(html).toContain('Adoption required');
    expect(html).toContain('22222222-2222-2222-2222-222222222222');
    expect(html).toContain('Adopt as project thread');
    expect(html).toContain('data-testid="project-human-thread-candidates"');
  });

  it('shows current generation, replacement confirmation, and read-only history', () => {
    const html = view({
      snapshot: snapshot({ current: binding, history: [
        { ...binding, generation: 1, bindingId: 'project-human-thread:arcade:1', conversationId: '33333333-3333-3333-3333-333333333333', predecessorGeneration: null, status: 'retired', retiredAt: '2026-08-22T12:00:00.000Z' },
        binding,
      ] }),
      replaceOpen: true,
      replaceReason: 'The existing conversation is unavailable.',
    });
    expect(html).toContain('Generation 2');
    expect(html).toContain('Current binding');
    expect(html).toContain('Controlled replacement');
    expect(html).toContain('Confirm replacement');
    expect(html).toContain('Predecessor history');
    expect(html).toContain('Read-only');
    expect(html).toContain('Generation 1');
    expect(html).toContain('The predecessor remains visible in the read-only history.');
  });

  it('renders recovery for unavailable bindings without exposing approval controls', () => {
    const html = view({ snapshot: snapshot({ current: { ...binding, status: 'unavailable' } }) });
    expect(html).toContain('Recover thread');
    expect(html).toContain('Only the project binding lifecycle is available here.');
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('Deploy');
  });

  it('offers durable resume and explicit candidate reconciliation after a browser restart', () => {
    const html = view({
      snapshot: snapshot({
        current: { ...binding, generation: 1, bindingId: 'project-human-thread:arcade:1', status: 'replacement-pending', predecessorGeneration: null },
        replacement: { expectedGeneration: 1, reason: 'The current conversation is unavailable.', createPhase: 'reconcile-required' },
        candidates: [{ conversationId: '22222222-2222-2222-2222-222222222222', canonicalPath: project.root, dev: '1', ino: '2', createdAt: 1 }],
      }),
    });
    expect(html).toContain('Resume replacement');
    expect(html).toContain('Reconcile candidate');
    expect(html).toContain('data-testid="project-human-thread-replacement-pending"');
    expect(html).not.toContain('Confirm replacement');
    const legacyHtml = view({
      snapshot: snapshot({ current: { ...binding, generation: 1, bindingId: 'project-human-thread:arcade:1', status: 'replacement-pending', predecessorGeneration: null }, candidates: [{ conversationId: '22222222-2222-2222-2222-222222222222', canonicalPath: project.root, dev: '1', ino: '2', createdAt: 1 }] }),
    });
    expect(legacyHtml).toContain('manual reconciliation');
    expect(legacyHtml).not.toContain('Resume replacement');
  });

  it('renders bounded choices and ordinary response entry without approval semantics', () => {
    const question: ProjectHumanThreadPublicQuestion = {
      messageId: 'question-choice',
      projectId: 'arcade',
      conversationId: '11111111-1111-1111-1111-111111111111',
      generation: 1,
      kind: 'bounded-choice',
      content: 'Choose the next project action.',
      choices: ['Continue conversation', 'Wait for user'],
      correlationId: 'corr-choice',
      occurredAt: '2026-08-22T12:00:00.000Z',
      state: 'pending',
    };
    const html = view({ pendingQuestions: [question] });
    expect(html).toContain('Project conversation');
    expect(html).toContain('Choose the next project action.');
    expect(html).toContain('Continue conversation');
    expect(html).toContain('Wait for user');
    expect(html).toContain('data-testid="project-human-thread-question-question-choice"');
    expect(html).not.toContain('Approve');
  });

  it('uses the familiar transcript and prompt interaction for the single designated thread', () => {
    const html = view({
      snapshot: snapshot({ current: binding }),
      conversation: {
        conversationId: binding.conversationId,
        generation: binding.generation,
        turns: [],
        hasEarlierTurns: false,
      },
      turnDraft: '',
      onTurnDraft: vi.fn(),
      onSendTurn: vi.fn(),
    });
    expect(html).toContain('Active stream');
    expect(html).toContain('Transcript');
    expect(html).toContain('Conversation history');
    expect(html).toContain('Send a message to the project thread');
    expect(html).toContain('The dedicated project conversation is ready.');
    expect(html).not.toContain('Create new thread');
  });
});
