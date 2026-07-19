import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelSession,
  closeSession,
  createDeviceBridgeProbeApproval,
  createSession,
  loginAndBootstrap,
  listActiveDeviceArtifacts,
  listArchivedSessions,
  readSessionStream,
  reopenSession,
  subscribeSessionStream,
  submitPrompt,
  submitDeviceDescriptorObservation,
} from '../client/sessionApi';
import type {
  AuditEvent,
  ManagedCodexThread,
  RoadexSession,
  StreamEvent,
  UserProfile,
  WorkspaceRef,
} from '../shared/sessionContracts';
import { isRunnerTerminal, lifecycleAfterTranscript, lifecycleForTerminalEvent } from './sessionSelection';
import { detectDeviceCapability, requestUsbDescriptor } from '../client/deviceCapability';
import { probeEsp32Identity } from '../client/esp32IdentityProbe';
import type {
  BrowserDeviceCapability,
  DeviceBridgePolicy,
  DeviceDescriptorObservationPublic,
  DeviceInventoryBindingRef,
} from '../shared/deviceBridgeContracts';

export type ConnectionState = 'loading' | 'connected' | 'streaming' | 'error';

export type RoadexSessionState = {
  connectionState: ConnectionState;
  token?: string;
  user?: UserProfile;
  workspaces: WorkspaceRef[];
  sessions: RoadexSession[];
  managedThreads: ManagedCodexThread[];
  deviceBridgePolicy?: DeviceBridgePolicy;
  browserDeviceCapability: BrowserDeviceCapability;
  deviceInventoryBindingRefs: DeviceInventoryBindingRef[];
  descriptorObservation?: DeviceDescriptorObservationPublic;
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
  attachManagedThread: (threadId: string, workspaceId: string) => Promise<void>;
  observeUsbDescriptor: () => Promise<void>;
  verifyEsp32Identity: () => Promise<void>;
  createProbeApproval: () => Promise<void>;
  retry: () => Promise<void>;
};

export function useRoadexSession(): RoadexSessionState {
  const [connectionState, setConnectionState] = useState<ConnectionState>('loading');
  const [token, setToken] = useState<string>();
  const [user, setUser] = useState<UserProfile>();
  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [sessions, setSessions] = useState<RoadexSession[]>([]);
  const [managedThreads, setManagedThreads] = useState<ManagedCodexThread[]>([]);
  const [deviceBridgePolicy, setDeviceBridgePolicy] = useState<DeviceBridgePolicy>();
  const [deviceInventoryBindingRefs, setDeviceInventoryBindingRefs] = useState<DeviceInventoryBindingRef[]>([]);
  const [descriptorObservation, setDescriptorObservation] = useState<DeviceDescriptorObservationPublic>();
  const browserDeviceCapability = useMemo(() => detectDeviceCapability(window.navigator), []);
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
      setManagedThreads(result.bootstrap.managedThreads);
      setDeviceBridgePolicy(result.bootstrap.deviceBridgePolicy);
      setDeviceInventoryBindingRefs(result.bootstrap.deviceInventoryBindingRefs);
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
        if (isRunnerTerminal(event)) {
          const lifecycle = lifecycleForTerminalEvent(event);
          if (!lifecycle) return;
          setSession((existing) => existing ? { ...existing, lifecycle } : existing);
          setSessions((existing) => updateSessionLifecycle(existing, sessionId, lifecycle));
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
      const targetSessionId = session.id;
      setConnectionState('streaming');
      setSession((existing) => existing ? { ...existing, lifecycle: 'streaming' } : existing);
      setSessions((existing) => updateSessionLifecycle(existing, session.id, 'streaming'));
      setError(undefined);
      setNotice(undefined);
      try {
        const response = await submitPrompt(token, session.id, prompt);
        setAuditEvents((existing) => [response.auditEvent, ...existing].slice(0, 8));
      } catch (caught) {
        setSessions((existing) => updateSessionLifecycle(existing, targetSessionId, 'ready'));
        if (activeStreamSessionId.current === targetSessionId) {
          setSession((existing) => existing?.id === targetSessionId ? { ...existing, lifecycle: 'ready' } : existing);
          setError(caught instanceof Error ? caught.message : 'Prompt submission failed.');
          setConnectionState('error');
        }
      }
    },
    [session, token],
  );

  const cancelPrompt = useCallback(async () => {
    if (!session) return;
    const targetSession = session;
    try {
      const response = await cancelSession(token, targetSession.id);
      setAuditEvents((existing) => [response.auditEvent, ...existing].slice(0, 8));
      const events = await readSessionStream(token, targetSession.id);
      setSessions((existing) => updateSessionLifecycle(existing, targetSession.id, 'ready'));
      if (activeStreamSessionId.current === targetSession.id) {
        setTranscript(events);
        setSession((existing) => existing?.id === targetSession.id ? { ...existing, lifecycle: 'ready' } : existing);
        setNotice(response.cancelled ? 'Cancel requested for the active Codex run.' : 'No Codex run is active for this session.');
        setConnectionState('connected');
      }
    } catch (caught) {
      if (activeStreamSessionId.current === targetSession.id) {
        setError(caught instanceof Error ? caught.message : 'Cancel request failed.');
        setNotice(undefined);
        setConnectionState('error');
      }
    }
  }, [session, token]);

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
      setManagedThreads(result.bootstrap.managedThreads);
      setDeviceBridgePolicy(result.bootstrap.deviceBridgePolicy);
      setDeviceInventoryBindingRefs(result.bootstrap.deviceInventoryBindingRefs);
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
      setManagedThreads(result.bootstrap.managedThreads);
      setDeviceBridgePolicy(result.bootstrap.deviceBridgePolicy);
      setDeviceInventoryBindingRefs(result.bootstrap.deviceInventoryBindingRefs);
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
        setManagedThreads(result.bootstrap.managedThreads);
        setDeviceBridgePolicy(result.bootstrap.deviceBridgePolicy);
        setDeviceInventoryBindingRefs(result.bootstrap.deviceInventoryBindingRefs);
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
        setManagedThreads(result.bootstrap.managedThreads);
        setDeviceBridgePolicy(result.bootstrap.deviceBridgePolicy);
        setDeviceInventoryBindingRefs(result.bootstrap.deviceInventoryBindingRefs);
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
          const lifecycle = lifecycleAfterTranscript(active, events);
          const selected = { ...active, lifecycle };
          setSessions((existing) => updateSessionLifecycle(existing, active.id, lifecycle));
          setSession(selected);
          activeStreamSessionId.current = active.id;
          setTranscript(events);
          setConnectionState(lifecycle === 'streaming' ? 'streaming' : 'connected');
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

  const attachManagedThread = useCallback(
    async (threadId: string, workspaceId: string) => {
      activeStreamSessionId.current = undefined;
      setConnectionState('loading');
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await createSession(token, { workspaceId, managedThreadId: threadId });
        setSessions(result.bootstrap.sessions);
        setManagedThreads(result.bootstrap.managedThreads);
        setDeviceBridgePolicy(result.bootstrap.deviceBridgePolicy);
        setDeviceInventoryBindingRefs(result.bootstrap.deviceInventoryBindingRefs);
        setSession(result.session);
        setAuditEvents(result.bootstrap.auditEvents);
        await refreshStream(result.session);
        setNotice('Managed Codex thread attached.');
        setConnectionState('connected');
      } catch (caught) {
        activeStreamSessionId.current = session?.id;
        setError(caught instanceof Error ? caught.message : 'Managed thread attach failed.');
        setConnectionState('error');
      }
    },
    [refreshStream, session, token],
  );

  const retry = useCallback(async () => {
    if (!workspaces[0]) {
      await attach();
      return;
    }

    try {
      const result = await createSession(token, { workspaceId: workspaces[0].id });
      setSessions(result.bootstrap.sessions);
      setManagedThreads(result.bootstrap.managedThreads);
      setDeviceBridgePolicy(result.bootstrap.deviceBridgePolicy);
      setSession(result.session);
      setAuditEvents(result.bootstrap.auditEvents);
      setTranscript(result.bootstrap.streamPreview);
      setConnectionState('connected');
    } catch {
      await attach();
    }
  }, [attach, token, workspaces]);

  const observeUsbDescriptor = useCallback(async () => {
    if (!session) return;
    const binding = deviceInventoryBindingRefs.find((candidate) => candidate.projectId === session.workspace.id);
    if (!binding) {
      setError('No active inventory binding is available for this project.');
      return;
    }
    setError(undefined);
    setNotice(undefined);
    try {
      const descriptor = await requestUsbDescriptor(window.navigator);
      const result = await submitDeviceDescriptorObservation(token, session.id, {
        inventoryBindingId: binding.id,
        ...descriptor,
      });
      setDescriptorObservation(result.observation);
      setNotice('USB descriptor observed. Device identity remains unverified.');
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'NotFoundError') {
        setNotice('USB selection was cancelled or no allowlisted device was selected.');
        return;
      }
      setError(caught instanceof Error ? caught.message : 'USB descriptor observation failed.');
    }
  }, [deviceInventoryBindingRefs, session, token]);

  const verifyEsp32Identity = useCallback(async () => {
    if (!session) return;
    const binding = deviceInventoryBindingRefs.find((candidate) => candidate.projectId === session.workspace.id);
    if (!binding) {
      setError('No active inventory binding is available for this project.');
      return;
    }
    if (!binding.identityVerificationAvailable) {
      setError('The active inventory binding must be recreated before identity verification is available.');
      return;
    }
    setError(undefined);
    setNotice(undefined);
    try {
      const identity = await probeEsp32Identity(window.navigator);
      const result = await submitDeviceDescriptorObservation(token, session.id, {
        inventoryBindingId: binding.id,
        ...identity,
      });
      setDescriptorObservation(result.observation);
      setNotice(result.observation.verification === 'verified'
        ? 'ESP32 identity verified against the project inventory binding.'
        : 'ESP32 identity does not match the project inventory binding.');
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'NotFoundError') {
        setNotice('Serial device selection was cancelled.');
        return;
      }
      setError(caught instanceof Error ? caught.message : 'ESP32 identity verification failed.');
    }
  }, [deviceInventoryBindingRefs, session, token]);

  const createProbeApproval = useCallback(async () => {
    if (!session || descriptorObservation?.verification !== 'verified') {
      setError('Verify the ESP32 identity before creating a probe approval.');
      return;
    }
    const binding = deviceInventoryBindingRefs.find((candidate) => candidate.projectId === session.workspace.id);
    if (!binding) {
      setError('No active inventory binding is available for this project.');
      return;
    }
    setError(undefined);
    setNotice(undefined);
    try {
      const artifacts = await listActiveDeviceArtifacts(token, session.id);
      const artifact = artifacts[0];
      if (!artifact) throw new Error('No active firmware artifact is available for this session.');
      await createDeviceBridgeProbeApproval(token, session.id, {
        workspaceId: session.workspace.id,
        artifactId: artifact.id,
        artifactSha256: artifact.sha256,
        inventoryBindingId: binding.id,
        operation: 'esp32.flash',
      });
      setNotice('Probe approval is ready for the controlled MSI test agent.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Probe approval failed.');
    }
  }, [descriptorObservation, deviceInventoryBindingRefs, session, token]);

  return useMemo(
    () => ({
      connectionState,
      token,
      user,
      workspaces,
      sessions,
      managedThreads,
      deviceBridgePolicy,
      browserDeviceCapability,
      deviceInventoryBindingRefs,
      descriptorObservation,
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
      attachManagedThread,
      observeUsbDescriptor,
      verifyEsp32Identity,
      createProbeApproval,
      retry,
    }),
    [
      auditEvents,
      archivedSessions,
      attachManagedThread,
      cancelPrompt,
      closeCurrentSession,
      connectionState,
      createThread,
      error,
      notice,
      managedThreads,
      deviceBridgePolicy,
      browserDeviceCapability,
      descriptorObservation,
      deviceInventoryBindingRefs,
      openWorkspace,
      observeUsbDescriptor,
      verifyEsp32Identity,
      createProbeApproval,
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

function updateSessionLifecycle(
  sessions: RoadexSession[],
  sessionId: string,
  lifecycle: RoadexSession['lifecycle'],
): RoadexSession[] {
  return sessions.map((candidate) => candidate.id === sessionId ? { ...candidate, lifecycle } : candidate);
}
