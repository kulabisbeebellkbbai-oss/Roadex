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

export function createSessionStoreFromState(state: SessionStore): SessionStore {
  return {
    sessions: [...state.sessions],
    streamEvents: [...state.streamEvents],
  };
}

export function getOwnedSession(store: SessionStore, userId: string, sessionId: string): RoadexSession | undefined {
  return store.sessions.find((session) => session.id === sessionId && session.userId === userId);
}

export function addStreamEvents(store: SessionStore, events: StreamEvent[]): void {
  store.streamEvents.push(...events);
  if (store.streamEvents.length > 500) {
    store.streamEvents.splice(0, store.streamEvents.length - 500);
  }
}
