import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelSession,
  authorizeVerifiedFirmwareWrite,
  closeSession,
  createDeviceBridgeProbeApproval,
  createSession,
  loginAndBootstrap,
  listActiveDeviceArtifacts,
  listArchivedSessions,
  readSessionStream,
  reopenSession,
  runDeviceBridgeProbe,
  confirmVerifiedDeviceProbe,
  loadVerifiedFirmware,
  reportVerifiedFirmwareWrite,
  subscribeSessionStream,
  submitPrompt,
  submitDeviceDescriptorObservation,
} from '../client/sessionApi';
import { flashVerifiedEsp32 } from '../client/esp32Flasher';
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
  DeviceBridgeApprovalPublic,
  DeviceBridgeOperationPublic,
  DeviceDescriptorObservationPublic,
  DeviceInventoryBindingRef,
} from '../shared/deviceBridgeContracts';
import type { SerialVerificationProfile } from '../shared/serialVerificationContracts';
import type { BleVerificationProfile } from '../shared/bleVerificationContracts';

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
  serialVerificationProfiles: SerialVerificationProfile[];
  bleVerificationProfiles: BleVerificationProfile[];
  descriptorObservation?: DeviceDescriptorObservationPublic;
  pendingProbeApproval?: DeviceBridgeApprovalPublic;
  pendingProbeConfirmation?: DeviceBridgeOperationPublic;
  verifiedFirmwareReady: boolean;
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
  runControlledProbe: () => Promise<void>;
  confirmControlledProbe: () => Promise<void>;
  loadConfirmedFirmware: () => Promise<void>;
  flashConfirmedFirmware: () => Promise<void>;
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
  const [serialVerificationProfiles, setSerialVerificationProfiles] = useState<SerialVerificationProfile[]>([]);
  const [bleVerificationProfiles, setBleVerificationProfiles] = useState<BleVerificationProfile[]>([]);
  const [descriptorObservation, setDescriptorObservation] = useState<DeviceDescriptorObservationPublic>();
  const [pendingProbeApproval, setPendingProbeApproval] = useState<DeviceBridgeApprovalPublic>();
  const [pendingProbeConfirmation, setPendingProbeConfirmation] = useState<DeviceBridgeOperationPublic>();
  const verifiedFirmwareBytes = useRef<ArrayBuffer | undefined>(undefined);
  const [verifiedFirmwareReady, setVerifiedFirmwareReady] = useState(false);
  const browserDeviceCapability = useMemo(() => detectDeviceCapability(window.navigator), []);
  const [session, setSession] = useState<RoadexSession>();
  const [archivedSessions, setArchivedSessions] = useState<RoadexSession[]>([]);
  const [transcript, setTranscript] = useState<StreamEvent[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const threadSelectionSequence = useRef(0);
  const activeStreamSessionId = useRef<string | undefined>(undefined);
  const verifiedDeviceMac = useRef<string | undefined>(undefined);

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
      setSerialVerificationProfiles(result.bootstrap.serialVerificationProfiles);
      setBleVerificationProfiles(result.bootstrap.bleVerificationProfiles);
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
    setDescriptorObservation(undefined);
    setPendingProbeApproval(undefined);
    setPendingProbeConfirmation(undefined);
    verifiedDeviceMac.current = undefined;
    verifiedFirmwareBytes.current = undefined;
    setVerifiedFirmwareReady(false);
  }, [sessionId]);

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
      verifiedDeviceMac.current = result.observation.verification === 'verified' ? identity.deviceMac : undefined;
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
    verifiedFirmwareBytes.current = undefined;
    setVerifiedFirmwareReady(false);
    try {
      const artifacts = await listActiveDeviceArtifacts(token, session.id);
      const artifact = artifacts[0];
      if (!artifact) throw new Error('No active firmware artifact is available for this session.');
      const approval = await createDeviceBridgeProbeApproval(token, session.id, {
        workspaceId: session.workspace.id,
        artifactId: artifact.id,
        artifactSha256: artifact.sha256,
        inventoryBindingId: binding.id,
        operation: 'esp32.flash',
      });
      setPendingProbeApproval(approval);
      setNotice('Probe approval is ready for the controlled browser probe.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Probe approval failed.');
    }
  }, [descriptorObservation, deviceInventoryBindingRefs, session, token]);

  const runControlledProbe = useCallback(async () => {
    if (!pendingProbeApproval) {
      setError('Create a fresh probe approval before running the controlled probe.');
      return;
    }
    if (!verifiedDeviceMac.current) {
      setError('Verify the ESP32 identity again before running the controlled probe.');
      return;
    }
    setError(undefined);
    setNotice(undefined);
    verifiedFirmwareBytes.current = undefined;
    setVerifiedFirmwareReady(false);
    try {
      const operation = await runDeviceBridgeProbe(token, pendingProbeApproval, verifiedDeviceMac.current);
      setPendingProbeApproval(undefined);
      setPendingProbeConfirmation(operation);
      setNotice('Controlled ESP32 probe verified. Fresh owner confirmation is required.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Controlled ESP32 probe failed.');
    }
  }, [pendingProbeApproval, token]);

  const confirmControlledProbe = useCallback(async () => {
    if (!pendingProbeConfirmation) return;
    setError(undefined);
    try {
      const operation = await confirmVerifiedDeviceProbe(token, pendingProbeConfirmation.id);
      setPendingProbeConfirmation(operation);
      setNotice('Verified target confirmed. Firmware delivery is available without device write authority.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Target confirmation failed.');
    }
  }, [pendingProbeConfirmation, token]);

  const loadConfirmedFirmware = useCallback(async () => {
    if (!pendingProbeConfirmation || pendingProbeConfirmation.phase !== 'confirmation') return;
    setError(undefined);
    setVerifiedFirmwareReady(false);
    verifiedFirmwareBytes.current = undefined;
    try {
      verifiedFirmwareBytes.current = await loadVerifiedFirmware(token, pendingProbeConfirmation);
      setVerifiedFirmwareReady(true);
      setNotice('Firmware verified in browser memory. No device write was performed.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Firmware verification failed.');
    }
  }, [pendingProbeConfirmation, token]);

  const flashConfirmedFirmware = useCallback(async () => {
    if (
      !pendingProbeConfirmation || pendingProbeConfirmation.phase !== 'confirmation' ||
      !verifiedFirmwareBytes.current || !verifiedDeviceMac.current || !deviceBridgePolicy?.writeEnabled
    ) return;
    if (!window.confirm('Flash the verified firmware to the selected ESP32? This writes flash memory and restarts the device.')) return;
    setError(undefined);
    setNotice('Waiting for the verified ESP32 bootloader.');
    let authorizedOperation: DeviceBridgeOperationPublic | undefined;
    let writeToken: string | undefined;
    let physicalWriteCompleted = false;
    try {
      await flashVerifiedEsp32(
        window.navigator,
        verifiedFirmwareBytes.current,
        verifiedDeviceMac.current,
        async (observedDeviceMac) => {
          const authorization = await authorizeVerifiedFirmwareWrite(token, pendingProbeConfirmation, observedDeviceMac);
          authorizedOperation = authorization.operation;
          writeToken = authorization.writeToken;
          setPendingProbeConfirmation(authorization.operation);
          return { phaseExpiresAt: authorization.operation.phaseExpiresAt };
        },
      );
      physicalWriteCompleted = true;
      if (!authorizedOperation || !writeToken) throw new Error('Firmware write authorization was not created.');
      const completed = await reportVerifiedFirmwareWrite(token, authorizedOperation, writeToken, 'completed');
      setPendingProbeConfirmation(completed);
      setNotice('Verified firmware flashed successfully. The ESP32 was restarted.');
    } catch (caught) {
      if (authorizedOperation && writeToken && !physicalWriteCompleted) {
        try {
          const failed = await reportVerifiedFirmwareWrite(token, authorizedOperation, writeToken, 'failed');
          setPendingProbeConfirmation(failed);
        } catch (reportError) {
          setError(`Firmware flash failed and its terminal report was not acknowledged: ${reportError instanceof Error ? reportError.message : 'unknown reporting error'}`);
          return;
        }
      }
      setError(physicalWriteCompleted
        ? 'Firmware was written and reset, but completion reporting was not acknowledged. Do not flash again until the operation is reconciled.'
        : caught instanceof Error ? caught.message : 'Verified firmware flash failed.');
    } finally {
      verifiedFirmwareBytes.current = undefined;
      verifiedDeviceMac.current = undefined;
      setVerifiedFirmwareReady(false);
    }
  }, [deviceBridgePolicy, pendingProbeConfirmation, token]);

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
      serialVerificationProfiles,
      bleVerificationProfiles,
      descriptorObservation,
      pendingProbeApproval,
      pendingProbeConfirmation,
      verifiedFirmwareReady,
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
      runControlledProbe,
      confirmControlledProbe,
      loadConfirmedFirmware,
      flashConfirmedFirmware,
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
      pendingProbeApproval,
      pendingProbeConfirmation,
      verifiedFirmwareReady,
      deviceInventoryBindingRefs,
      serialVerificationProfiles,
      bleVerificationProfiles,
      openWorkspace,
      observeUsbDescriptor,
      verifyEsp32Identity,
      createProbeApproval,
      runControlledProbe,
      confirmControlledProbe,
      loadConfirmedFirmware,
      flashConfirmedFirmware,
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
