import { describe, expect, it } from 'vitest';
import { isAvailableProjectHumanThreadConversationRoute, validProjectHumanThreadConversationCsrf } from '../src/server/projectHumanThreadConversationPolicy';

describe('project human conversation route policy', () => {
  const env = { ROADEX_PROJECT_HUMAN_THREAD_ENABLED: 'true' } as NodeJS.ProcessEnv;

  it('exposes only exact conversation read and message routes', () => {
    expect(isAvailableProjectHumanThreadConversationRoute('GET', '/api/projects/arcade/human-thread/conversation', env)).toBe(true);
    expect(isAvailableProjectHumanThreadConversationRoute('POST', '/api/projects/arcade/human-thread/conversation/messages', env)).toBe(true);
    expect(isAvailableProjectHumanThreadConversationRoute('POST', '/api/projects/arcade/human-thread/conversation', env)).toBe(false);
    expect(isAvailableProjectHumanThreadConversationRoute('GET', '/api/projects/arcade/human-thread/conversation/messages', env)).toBe(false);
    expect(isAvailableProjectHumanThreadConversationRoute('POST', '/api/projects/arcade/human-thread/conversation/messages?x=1', env)).toBe(false);
  });

  it('requires one bounded csrf header', () => {
    expect(validProjectHumanThreadConversationCsrf(undefined)).toBe(false);
    expect(validProjectHumanThreadConversationCsrf('private-test-value')).toBe(true);
    expect(validProjectHumanThreadConversationCsrf(' private-test-value ')).toBe(false);
  });
});
