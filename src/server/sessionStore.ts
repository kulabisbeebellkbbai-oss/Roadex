import type { RoadexSession, StreamEvent } from '../shared/sessionContracts.js';

export type SessionStore = {
  sessions: RoadexSession[];
  streamEvents: StreamEvent[];
};

export function createSessionStore(): SessionStore {
  return {
    sessions: [],
    streamEvents: [],
  };
}

export function getOwnedSession(store: SessionStore, userId: string, sessionId: string): RoadexSession | undefined {
  return store.sessions.find((session) => session.id === sessionId && session.userId === userId);
}

export function addStreamEvents(store: SessionStore, events: StreamEvent[]): void {
  store.streamEvents.push(...events);
}
