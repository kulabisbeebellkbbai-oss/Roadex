import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createSession,
  loginAndBootstrap,
  readSessionStream,
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
  transcript: StreamEvent[];
  auditEvents: AuditEvent[];
  error?: string;
  sendPrompt: (prompt: string) => Promise<void>;
  retry: () => Promise<void>;
};

export function useRoadexSession(): RoadexSessionState {
  const [connectionState, setConnectionState] = useState<ConnectionState>('loading');
  const [token, setToken] = useState<string>();
  const [user, setUser] = useState<UserProfile>();
  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [session, setSession] = useState<RoadexSession>();
  const [transcript, setTranscript] = useState<StreamEvent[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string>();

  const attach = useCallback(async () => {
    setConnectionState('loading');
    setError(undefined);
    try {
      const result = await loginAndBootstrap();
      const activeSession = result.bootstrap.sessions[0];
      setToken(result.token);
      setUser(result.bootstrap.user);
      setWorkspaces(result.bootstrap.workspaces);
      setSession(activeSession);
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

  const sendPrompt = useCallback(
    async (prompt: string) => {
      if (!session) return;
      setConnectionState('streaming');
      setError(undefined);
      try {
        const response = await submitPrompt(token, session.id, prompt);
        const events = await readSessionStream(token, session.id);
        setTranscript(events);
        setAuditEvents((existing) => [response.auditEvent, ...existing].slice(0, 8));
        setConnectionState('connected');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Prompt submission failed.');
        setConnectionState('error');
      }
    },
    [session, token],
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
      transcript,
      auditEvents,
      error,
      sendPrompt,
      retry,
    }),
    [
      auditEvents,
      connectionState,
      error,
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
