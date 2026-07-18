import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelSession,
  closeSession,
  createSession,
  loginAndBootstrap,
  listArchivedSessions,
  readSessionStream,
  reopenSession,
  subscribeSessionStream,
  submitPrompt,
} from '../client/sessionApi';
import type {
  AuditEvent,
  RoadexSession,
  StreamEvent,
  UserProfile,
  WorkspaceRef,
} from '../shared/sessionContracts';

export type ConnectionState = 'loading' | 'connected' | 'streaming' | 'error';

export type RoadexSessionState = {
  connectionState: ConnectionState;
  token?: string;
  user?: UserProfile;
  workspaces: WorkspaceRef[];
  sessions: RoadexSession[];
  session?: RoadexSession;
  archivedSessions: RoadexSession[];
  transcript: StreamEvent[];
  auditEvents: AuditEvent[];
  error?: string;
  notice?: string;
  sendPrompt: (prompt: string) => Promise<void>;
  cancelPrompt: () => Promise<void>;
  closeCurrentSession: () => Promise<void>;
  reopenArchivedSession: (sessionId: string) => Promise<void>;
  openWorkspace: (workspaceId: string) => Promise<void>;
  createThread: (workspaceId: string) => Promise<void>;
  selectThread: (sessionId: string) => Promise<void>;
  retry: () => Promise<void>;
};

export function useRoadexSession(): RoadexSessionState {
  const [connectionState, setConnectionState] = useState<ConnectionState>('loading');
  const [token, setToken] = useState<string>();
  const [user, setUser] = useState<UserProfile>();
  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [sessions, setSessions] = useState<RoadexSession[]>([]);
  const [session, setSession] = useState<RoadexSession>();
  const [archivedSessions, setArchivedSessions] = useState<RoadexSession[]>([]);
  const [transcript, setTranscript] = useState<StreamEvent[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const threadSelectionSequence = useRef(0);
  const activeStreamSessionId = useRef<string | undefined>(undefined);

  const refreshStream = useCallback(
    async (targetSession: RoadexSession | undefined = session) => {
      if (!targetSession) return [];
      const events = await readSessionStream(token, targetSession.id);
      setTranscript(events);
      return events;
    },
    [session, token],
  );

  const attach = useCallback(async () => {
    setConnectionState('loading');
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await loginAndBootstrap();
      const activeSession = result.bootstrap.sessions[0];
      setToken(result.token);
      setUser(result.bootstrap.user);
      setWorkspaces(result.bootstrap.workspaces);
      setSessions(result.bootstrap.sessions);
      setSession(activeSession);
      const archived = await listArchivedSessions(result.token);
      setArchivedSessions(archived.sessions);
      setAuditEvents(result.bootstrap.auditEvents);
      setTranscript(result.bootstrap.streamPreview);
      if (activeSession) {
        const events = await readSessionStream(result.token, activeSession.id);
        setTranscript(events);
      }
      setConnectionState('connected');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Roadex session attach failed.');
      setConnectionState('error');
    }
  }, []);

  useEffect(() => {
    void attach();
  }, [attach]);

  const sessionId = session?.id;
  useEffect(() => {
    if (!sessionId) return undefined;
    activeStreamSessionId.current = sessionId;
    return subscribeSessionStream(
      token,
      sessionId,
      (event) => {
        if (activeStreamSessionId.current !== sessionId) return;
        setTranscript((existing) => mergeStreamEvents(existing, [event]));
        if (isTerminalRunnerEvent(event)) {
          setSession((existing) => existing ? { ...existing, lifecycle: 'ready' } : existing);
          setConnectionState('connected');
        }
      },
      (streamError) => {
        if (activeStreamSessionId.current !== sessionId) return;
        setError(streamError.message);
        setConnectionState('error');
      },
    );
  }, [sessionId, token]);

  const sendPrompt = useCallback(
    async (prompt: string) => {
      if (!session) return;
      setConnectionState('streaming');
      setSession((existing) => existing ? { ...existing, lifecycle: 'streaming' } : existing);
      setError(undefined);
      setNotice(undefined);
      try {
        const response = await submitPrompt(token, session.id, prompt);
        setAuditEvents((existing) => [response.auditEvent, ...existing].slice(0, 8));
      } catch (caught) {
        setSession((existing) => existing ? { ...existing, lifecycle: 'ready' } : existing);
        setError(caught instanceof Error ? caught.message : 'Prompt submission failed.');
        setConnectionState('error');
      }
    },
    [session, token],
  );

  const cancelPrompt = useCallback(async () => {
    if (!session) return;
    try {
      const response = await cancelSession(token, session.id);
      setAuditEvents((existing) => [response.auditEvent, ...existing].slice(0, 8));
      setNotice(response.cancelled ? 'Cancel requested for the active Codex run.' : 'No Codex run is active for this session.');
      await refreshStream(session);
      setSession((existing) => existing ? { ...existing, lifecycle: 'ready' } : existing);
      setConnectionState('connected');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Cancel request failed.');
      setNotice(undefined);
      setConnectionState('error');
    }
  }, [refreshStream, session, token]);

  const closeCurrentSession = useCallback(async () => {
    if (!session) return;
    setConnectionState('loading');
    setError(undefined);
    setNotice(undefined);
    activeStreamSessionId.current = undefined;
    try {
      const response = await closeSession(token, session.id);
      const result = await loginAndBootstrap();
      const archived = await listArchivedSessions(result.token);
      const activeSession = result.bootstrap.sessions[0];
      setToken(result.token);
      setUser(result.bootstrap.user);
      setWorkspaces(result.bootstrap.workspaces);
      setSessions(result.bootstrap.sessions);
      setSession(activeSession);
      setArchivedSessions(archived.sessions);
      setAuditEvents([response.auditEvent, ...result.bootstrap.auditEvents].slice(0, 8));
      setTranscript(result.bootstrap.streamPreview.filter((event) => !activeSession || event.sessionId === activeSession.id));
      if (activeSession) {
        const events = await readSessionStream(result.token, activeSession.id);
        setTranscript(events);
      }
      setNotice('Session archived.');
      setConnectionState('connected');
    } catch (caught) {
      activeStreamSessionId.current = session.id;
      setError(caught instanceof Error ? caught.message : 'Session archive failed.');
      setNotice(undefined);
      setConnectionState('error');
    }
  }, [session, token]);

  const reopenArchivedSession = useCallback(async (sessionId: string) => {
    setConnectionState('loading');
    setError(undefined);
    setNotice(undefined);
    activeStreamSessionId.current = undefined;
    try {
      const response = await reopenSession(token, sessionId);
      const result = await loginAndBootstrap();
      const archived = await listArchivedSessions(result.token);
      setToken(result.token);
      setUser(result.bootstrap.user);
      setWorkspaces(result.bootstrap.workspaces);
      setSessions(result.bootstrap.sessions);
      setSession(response.session);
      setArchivedSessions(archived.sessions);
      setAuditEvents((existing) => [response.auditEvent, ...existing].slice(0, 8));
      await refreshStream(response.session);
      setNotice('Archived session reopened.');
      setConnectionState('connected');
    } catch (caught) {
      activeStreamSessionId.current = session?.id;
      setError(caught instanceof Error ? caught.message : 'Session reopen failed.');
      setConnectionState('error');
    }
  }, [refreshStream, session, token]);

  const openWorkspace = useCallback(
    async (workspaceId: string) => {
      setConnectionState('loading');
      setError(undefined);
      setNotice(undefined);
      activeStreamSessionId.current = undefined;
      try {
        const result = await createSession(token, { workspaceId });
        const nextSession = result.session;
        setSessions(result.bootstrap.sessions);
        setSession(nextSession);
        setAuditEvents(result.bootstrap.auditEvents);
        setTranscript(result.bootstrap.streamPreview.filter((event) => event.sessionId === nextSession.id));
        await refreshStream(nextSession);
        setConnectionState('connected');
      } catch (caught) {
        activeStreamSessionId.current = session?.id;
        setError(caught instanceof Error ? caught.message : 'Workspace attach failed.');
        setConnectionState('error');
      }
    },
    [refreshStream, session, token],
  );

  const createThread = useCallback(
    async (workspaceId: string) => {
      setConnectionState('loading');
      setError(undefined);
      setNotice(undefined);
      activeStreamSessionId.current = undefined;
      try {
        const result = await createSession(token, { workspaceId, newThread: true });
        setSessions(result.bootstrap.sessions);
        setSession(result.session);
        setAuditEvents(result.bootstrap.auditEvents);
        await refreshStream(result.session);
        setNotice('New thread created.');
        setConnectionState('connected');
      } catch (caught) {
        activeStreamSessionId.current = session?.id;
        setError(caught instanceof Error ? caught.message : 'Thread creation failed.');
        setConnectionState('error');
      }
    },
    [refreshStream, session, token],
  );

  const selectThread = useCallback(
    async (sessionId: string) => {
      const active = sessions.find((candidate) => candidate.id === sessionId);
      if (active) {
        const sequence = ++threadSelectionSequence.current;
        const previousSessionId = session?.id;
        activeStreamSessionId.current = undefined;
        setConnectionState('loading');
        setError(undefined);
        setNotice(undefined);
        try {
          const events = await readSessionStream(token, active.id);
          if (sequence !== threadSelectionSequence.current) return;
          setSession(active);
          activeStreamSessionId.current = active.id;
          setTranscript(events);
          setConnectionState('connected');
        } catch (caught) {
          if (sequence !== threadSelectionSequence.current) return;
          activeStreamSessionId.current = previousSessionId;
          setError(caught instanceof Error ? caught.message : 'Thread selection failed.');
          setConnectionState('error');
        }
        return;
      }
      await reopenArchivedSession(sessionId);
    },
    [reopenArchivedSession, session, sessions, token],
  );

  const retry = useCallback(async () => {
    if (!workspaces[0]) {
      await attach();
      return;
    }

    try {
      const result = await createSession(token, { workspaceId: workspaces[0].id });
      setSessions(result.bootstrap.sessions);
      setSession(result.session);
      setAuditEvents(result.bootstrap.auditEvents);
      setTranscript(result.bootstrap.streamPreview);
      setConnectionState('connected');
    } catch {
      await attach();
    }
  }, [attach, token, workspaces]);

  return useMemo(
    () => ({
      connectionState,
      token,
      user,
      workspaces,
      sessions,
      session,
      archivedSessions,
      transcript,
      auditEvents,
      error,
      notice,
      sendPrompt,
      cancelPrompt,
      closeCurrentSession,
      reopenArchivedSession,
      openWorkspace,
      createThread,
      selectThread,
      retry,
    }),
    [
      auditEvents,
      archivedSessions,
      cancelPrompt,
      closeCurrentSession,
      connectionState,
      createThread,
      error,
      notice,
      openWorkspace,
      reopenArchivedSession,
      retry,
      sendPrompt,
      session,
      sessions,
      selectThread,
      token,
      transcript,
      user,
      workspaces,
    ],
  );
}

function mergeStreamEvents(existing: StreamEvent[], next: StreamEvent[]): StreamEvent[] {
  const eventsById = new Map(existing.map((event) => [event.id, event]));
  for (const event of next) {
    eventsById.set(event.id, event);
  }
  return [...eventsById.values()];
}

function isTerminalRunnerEvent(event: StreamEvent): boolean {
  return (
    event.message === 'Codex runner completed.' ||
    event.message.includes('Codex runner was cancelled.') ||
    event.message.includes('Codex runner timed out')
  );
}
