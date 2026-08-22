import { describe, expect, it } from 'vitest';
import {
  isAvailableProjectHumanThreadQuestionRoute,
  isAvailableProjectHumanThreadTranscriptRoute,
} from '../src/server/projectHumanThreadTranscriptPolicy';

const env = { ROADEX_PROJECT_HUMAN_THREAD_ENABLED: 'true' };

describe('project human thread transcript routes', () => {
  it('exposes only owner reads and response submission', () => {
    expect(isAvailableProjectHumanThreadTranscriptRoute('GET', '/api/projects/arcade/human-thread/messages', env)).toBe(true);
    expect(isAvailableProjectHumanThreadTranscriptRoute('GET', '/api/projects/arcade/human-thread/messages/history', env)).toBe(true);
    expect(isAvailableProjectHumanThreadTranscriptRoute('POST', '/api/projects/arcade/human-thread/messages/question-1/respond', env)).toBe(true);
    for (const [method, path] of [
      ['POST', '/api/projects/arcade/human-thread/messages'],
      ['GET', '/api/projects/arcade/human-thread/messages/question-1/respond'],
      ['POST', '/api/projects/arcade/human-thread/messages/question-1/approve'],
      ['POST', '/api/projects/arcade/human-thread/messages/question-1/respond?x=1'],
    ] as const) {
      expect(isAvailableProjectHumanThreadTranscriptRoute(method, path, env)).toBe(false);
    }
  });

  it('keeps the inbound question route exact and default-off', () => {
    expect(isAvailableProjectHumanThreadQuestionRoute('POST', '/api/internal/overseer/project-human-thread/questions', env)).toBe(true);
    expect(isAvailableProjectHumanThreadQuestionRoute('GET', '/api/internal/overseer/project-human-thread/questions', env)).toBe(false);
    expect(isAvailableProjectHumanThreadQuestionRoute('POST', '/api/internal/overseer/project-human-thread/questions/extra', env)).toBe(false);
    expect(isAvailableProjectHumanThreadQuestionRoute('POST', '/api/internal/overseer/project-human-thread/questions', {})).toBe(false);
  });
});
