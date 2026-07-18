import { useCallback, useEffect, useMemo, useState } from 'react';
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
  retry: () => Promise<void>;
};

export function useRoadexSession(): RoadexSessionState {
  const [connectionState, setConnectionState] = useState<ConnectionState>('loading');
  const [token, setToken] = useState<string>();
  const [user, setUser] = useState<UserProfile>();
  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [session, setSession] = useState<RoadexSession>();
  const [archivedSessions, setArchivedSessions] = useState<RoadexSession[]>([]);
  const [transcript, setTranscript] = useState<StreamEvent[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

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
    return subscribeSessionStream(
      token,
      sessionId,
      (event) => {
        setTranscript((existing) => mergeStreamEvents(existing, [event]));
        if (isTerminalRunnerEvent(event)) {
          setSession((existing) => existing ? { ...existing, lifecycle: 'ready' } : existing);
          setConnectionState('connected');
        }
      },
      (streamError) => {
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
    try {
      const response = await closeSession(token, session.id);
      const result = await loginAndBootstrap();
      const archived = await listArchivedSessions(result.token);
      const activeSession = result.bootstrap.sessions[0];
      setToken(result.token);
      setUser(result.bootstrap.user);
      setWorkspaces(result.bootstrap.workspaces);
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
      setError(caught instanceof Error ? caught.message : 'Session archive failed.');
      setNotice(undefined);
      setConnectionState('error');
    }
  }, [session, token]);

  const reopenArchivedSession = useCallback(async (sessionId: string) => {
    setConnectionState('loading');
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await reopenSession(token, sessionId);
      const archived = await listArchivedSessions(token);
      setSession(response.session);
      setArchivedSessions(archived.sessions);
      setAuditEvents((existing) => [response.auditEvent, ...existing].slice(0, 8));
      await refreshStream(response.session);
      setNotice('Archived session reopened.');
      setConnectionState('connected');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Session reopen failed.');
      setConnectionState('error');
    }
  }, [refreshStream, token]);

  const openWorkspace = useCallback(
    async (workspaceId: string) => {
      setConnectionState('loading');
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await createSession(token, { workspaceId });
        const nextSession =
          result.sessions.find((candidate) => candidate.workspace.id === workspaceId) ?? result.sessions[0];
        setSession(nextSession);
        setAuditEvents(result.auditEvents);
        setTranscript(result.streamPreview.filter((event) => !nextSession || event.sessionId === nextSession.id));
        setConnectionState('connected');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Workspace attach failed.');
        setConnectionState('error');
      }
    },
    [token],
  );

  const retry = useCallback(async () => {
    if (!workspaces[0]) {
      await attach();
      return;
    }

    try {
      const result = await createSession(token, { workspaceId: workspaces[0].id });
      setSession(result.sessions[0]);
      setAuditEvents(result.auditEvents);
      setTranscript(result.streamPreview);
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
      retry,
    }),
    [
      auditEvents,
      archivedSessions,
      cancelPrompt,
      closeCurrentSession,
      connectionState,
      error,
      notice,
      openWorkspace,
      reopenArchivedSession,
      retry,
      sendPrompt,
      session,
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
