import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectHumanThreadPanelView, type ProjectHumanThreadSnapshot } from '../src/ProjectHumanThreadPanel';
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
      replaceOpen={false}
      replaceReason=""
      onRefresh={vi.fn()}
      onCreate={vi.fn()}
      onAdopt={vi.fn()}
      onRecover={vi.fn()}
      onReplaceOpen={vi.fn()}
      onReplaceReason={vi.fn()}
      onReplace={vi.fn()}
      {...overrides}
    />,
  );
}

describe('project human thread UI', () => {
  it('offers creation when a project has no current binding or candidates', () => {
    const html = view();
    expect(html).toContain('Project thread');
    expect(html).toContain('No project thread is bound');
    expect(html).toContain('Create project thread');
    expect(html).toContain('Overseer approvals remain a separate authority surface.');
    expect(html).toContain('data-testid="project-human-thread-missing"');
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
});
