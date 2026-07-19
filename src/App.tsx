import { FormEvent, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Archive,
  Bot,
  CirclePause,
  CheckCircle2,
  ChevronRight,
  Clock3,
  KeyRound,
  LockKeyhole,
  Menu,
  MonitorSmartphone,
  Monitor,
  PlugZap,
  Plus,
  RadioTower,
  ShieldCheck,
  Smartphone,
  TerminalSquare,
  UserRound,
} from 'lucide-react';
import { useRoadexSession } from './hooks/useRoadexSession';
import { navItems } from './roadexModel';
import { isVisibleTranscriptEvent } from './transcript';
import { resolveLayoutMode, toggleLayoutMode } from './layoutMode';
import { hasBleRuntimeVerification, verifyBleRuntime } from './client/bleRuntimeVerifier';
import { hasSerialRuntimeVerification, verifySerialRuntime } from './client/serialRuntimeVerifier';

function App() {
  const roadex = useRoadexSession();
  const [prompt, setPrompt] = useState('');
  const [sidebarPanel, setSidebarPanel] = useState<'projects' | 'sessions' | 'devices' | 'security'>('projects');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [bleVerification, setBleVerification] = useState<'idle' | 'checking' | 'verified' | 'error'>('idle');
  const [bleVerificationMessage, setBleVerificationMessage] = useState('');
  const [serialVerification, setSerialVerification] = useState<'idle' | 'checking' | 'verified' | 'error'>('idle');
  const [serialVerificationMessage, setSerialVerificationMessage] = useState('');
  const [layoutMode, setLayoutMode] = useState(() => resolveLayoutMode(
    readLayoutPreference(),
    window.matchMedia('(max-width: 720px)').matches,
  ));
  const session = roadex.session;
  const selectedProject = roadex.workspaces.find(
    (workspace) => workspace.id === (selectedProjectId || session?.workspace.id),
  );
  const visibleTranscript = roadex.transcript.filter(isVisibleTranscriptEvent);
  const roadexProjectThreads = [...roadex.sessions, ...roadex.archivedSessions]
    .filter((candidate) => candidate.workspace.id === selectedProject?.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const attachedCodexThreadIds = new Set(
    [...roadex.sessions, ...roadex.archivedSessions]
      .map((candidate) => candidate.codexThreadId)
      .filter((threadId): threadId is string => Boolean(threadId)),
  );
  const managedProjectThreads = roadex.managedThreads.filter(
    (candidate) => candidate.project.id === selectedProject?.id && !attachedCodexThreadIds.has(candidate.id),
  );
  const selectedRoadexThread = session && session.workspace.id === selectedProject?.id ? `roadex:${session.id}` : '';
  const composerDisabled =
    roadex.connectionState === 'loading' ||
    roadex.connectionState === 'streaming' ||
    roadex.connectionState === 'error' ||
    !session ||
    session.lifecycle !== 'ready';

  useEffect(() => {
    try {
      window.localStorage.setItem('roadex-layout-mode', layoutMode);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }, [layoutMode]);

  useEffect(() => {
    if (session?.workspace.id) setSelectedProjectId(session.workspace.id);
  }, [session?.id, session?.workspace.id]);

  async function handlePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (composerDisabled || !prompt.trim()) return;
    const nextPrompt = prompt;
    setPrompt('');
    await roadex.sendPrompt(nextPrompt);
  }

  async function handleBleVerification() {
    setBleVerification('checking');
    setBleVerificationMessage('');
    try {
      const result = await verifyBleRuntime(window.navigator);
      setBleVerification('verified');
      setBleVerificationMessage(`Firmware ${result.firmware} verified; disconnected sensors reported correctly.`);
    } catch (error) {
      setBleVerification('error');
      setBleVerificationMessage(error instanceof Error ? error.message : 'BLE runtime verification failed.');
    }
  }

  async function handleSerialVerification() {
    setSerialVerification('checking');
    setSerialVerificationMessage('Select the ESP32, then press RESET/EN while Roadex listens.');
    try {
      await verifySerialRuntime(window.navigator);
      setSerialVerification('verified');
      setSerialVerificationMessage('Boot verified; BLE initialization started and disconnected sensors were handled correctly.');
    } catch (error) {
      setSerialVerification('error');
      setSerialVerificationMessage(error instanceof Error ? error.message : 'Serial runtime verification failed.');
    }
  }

  return (
    <main className={`app-shell layout-${layoutMode}`}>
      <aside className="sidebar" aria-label="Roadex navigation">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <Bot size={22} />
          </div>
          <div>
            <strong>Roadex</strong>
            <span>Codex Portal</span>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map((item) => (
            <button
              aria-expanded={item.label === 'Projects' ? sidebarPanel === 'projects' : undefined}
              aria-label={item.label}
              className={`nav-item${
                item.label.toLowerCase() === sidebarPanel
                  ? ' active'
                  : ''
              }`}
              key={item.label}
              onClick={() => {
                if (item.label === 'Projects') {
                  setSidebarPanel('projects');
                  return;
                }
                setSidebarPanel(item.label.toLowerCase() as 'sessions' | 'devices' | 'security');
                if (item.label === 'Security') document.getElementById('security-checks')?.scrollIntoView({ behavior: 'smooth' });
                if (item.label === 'Devices') document.getElementById('device-status')?.scrollIntoView({ behavior: 'smooth' });
              }}
              type="button"
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        {sidebarPanel === 'projects' ? (
          <section className="sidebar-projects" aria-label="Project and thread connection">
            <div className="sidebar-panel-heading">
              <div>
                <span>Connection</span>
                <strong>Projects</strong>
              </div>
              <button
                aria-label="Create new thread"
                disabled={!selectedProject || roadex.connectionState === 'loading'}
                onClick={() => selectedProject && void roadex.createThread(selectedProject.id)}
                title="Create new thread"
                type="button"
              >
                <Plus size={17} />
              </button>
            </div>
            <label>
              <span>Project</span>
              <select
                disabled={roadex.connectionState === 'loading'}
                onChange={(event) => setSelectedProjectId(event.target.value)}
                value={selectedProject?.id ?? ''}
              >
                {roadex.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Thread</span>
              <select
                disabled={!selectedProject || roadex.connectionState === 'loading'}
                onChange={(event) => {
                  const [source, id] = event.target.value.split(':', 2);
                  if (source === 'roadex') void roadex.selectThread(id);
                  if (source === 'managed' && selectedProject) void roadex.attachManagedThread(id, selectedProject.id);
                }}
                value={selectedRoadexThread}
              >
                {!selectedRoadexThread ? <option value="">Select a thread</option> : null}
                {roadexProjectThreads.map((candidate) => (
                  <option key={candidate.id} value={`roadex:${candidate.id}`}>
                    {candidate.lifecycle === 'closed' ? 'Archived' : 'Active'} · {candidate.id.slice(-8)} · {new Date(candidate.updatedAt).toLocaleString()}
                  </option>
                ))}
                {managedProjectThreads.map((candidate) => (
                  <option key={candidate.id} value={`managed:${candidate.id}`}>
                    Codex Projects · {candidate.label} · {new Date(candidate.updatedAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <div className="sidebar-project-meta" title={selectedProject?.root}>
              <span>{selectedProject?.name ?? 'No project selected'}</span>
              <strong>{session && session.workspace.id === selectedProject?.id ? session.lifecycle : 'browse'}</strong>
            </div>
          </section>
        ) : null}

        <section className="trust-panel" aria-label="Security posture">
          <ShieldCheck size={20} />
          <div>
            <strong>Security-first phase</strong>
            <span>Device access stays disabled until the core portal passes review.</span>
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar session-topbar">
          <button className="icon-button" type="button" aria-label="Open menu">
            <Menu size={20} />
          </button>
          <div className="topbar-title">
            <span>{roadex.user?.displayName ?? 'Attaching user'}</span>
            <strong title={session?.workspace.root}>
              {session?.workspace.root ?? '/srv/roadex/projects/...'}
            </strong>
          </div>
          <div className="session-pill">
            <Activity size={16} />
            <span>{roadex.connectionState}</span>
          </div>
          <button
            aria-label={`Switch to ${layoutMode === 'desktop' ? 'mobile' : 'desktop'} layout`}
            aria-pressed={layoutMode === 'mobile'}
            className="icon-button layout-toggle"
            onClick={() => setLayoutMode((current) => toggleLayoutMode(current))}
            title={`Switch to ${layoutMode === 'desktop' ? 'mobile' : 'desktop'} layout`}
            type="button"
          >
            {layoutMode === 'desktop' ? <Smartphone size={19} /> : <Monitor size={19} />}
          </button>
        </header>

        <section className="session-header">
          <div>
            <span className="eyebrow">Live Roadex session</span>
            <h1>{session?.workspace.name ?? 'Attaching session'}</h1>
          </div>
          <div className="session-facts" aria-label="Session facts">
            <span>{session?.id ?? 'pending'}</span>
            <span>{session?.lifecycle ?? 'loading'}</span>
            <span>{session?.transport ?? 'sse'}</span>
            <span>{session?.runnerMode ?? 'mock'} runner</span>
            <span>{session?.codexThreadId ? 'thread linked' : 'new thread'}</span>
          </div>
        </section>

        {roadex.error ? (
          <section className="error-banner" role="alert">
            <AlertTriangle size={20} />
            <span>{roadex.error}</span>
            <button type="button" onClick={roadex.retry}>
              Retry
            </button>
          </section>
        ) : null}

        {roadex.notice && !roadex.error ? (
          <section className="notice-banner" role="status">
            <CheckCircle2 size={20} />
            <span>{roadex.notice}</span>
          </section>
        ) : null}

        <section className="dashboard-grid live-grid" aria-label="Roadex dashboard">
          <article className="codex-panel">
            <div className="panel-heading">
              <div>
                <span className="section-label">Active stream</span>
                <h2>Transcript</h2>
              </div>
              <span className="status-dot">{session?.lifecycle ?? 'loading'}</span>
            </div>

            <div className="transcript" aria-live="polite">
              {roadex.connectionState === 'loading' ? (
                <>
                  <div className="message skeleton" />
                  <div className="message skeleton" />
                  <div className="message skeleton" />
                </>
              ) : null}

              {visibleTranscript.map((event) => (
                <div className={`message ${event.kind}`} key={event.id}>
                  {event.kind === 'user' ? <p>{event.message}</p> : null}
                  {event.kind === 'assistant' ? (
                    <Bot size={18} />
                  ) : event.kind === 'user' ? (
                    <UserRound size={18} />
                  ) : (
                    <TerminalSquare size={18} />
                  )}
                  {event.kind !== 'user' ? <p>{event.message}</p> : null}
                </div>
              ))}

              {visibleTranscript.length === 0 && roadex.connectionState === 'connected' ? (
                <div className="message system">
                  <TerminalSquare size={18} />
                  <p>Codex session is ready. Send a prompt to run on the server workspace.</p>
                </div>
              ) : null}
            </div>

            <form className="prompt-row" onSubmit={handlePrompt}>
              <label className="sr-only" htmlFor="prompt">
                Prompt
              </label>
              <input
                disabled={composerDisabled}
                id="prompt"
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={
                  roadex.connectionState === 'streaming'
                    ? 'Streaming Codex response...'
                    : 'Send a prompt to the server-side Codex session'
                }
                type="text"
                value={prompt}
              />
              <button disabled={composerDisabled || !prompt.trim()} type="submit">
                <ChevronRight size={20} />
              </button>
              <button
                aria-label="Cancel running prompt"
                disabled={roadex.connectionState !== 'streaming'}
                onClick={() => void roadex.cancelPrompt()}
                type="button"
              >
                <CirclePause size={20} />
              </button>
              <button
                aria-label="Archive session"
                disabled={!session || roadex.connectionState === 'loading'}
                onClick={() => void roadex.closeCurrentSession()}
                type="button"
              >
                <Archive size={20} />
              </button>
            </form>
          </article>

          <aside className="side-stack operational-rail">
            <article className="metric-card">
              <MonitorSmartphone size={22} />
              <div>
                <span>Responsive target</span>
                <strong>Desktop, tablet, mobile</strong>
              </div>
            </article>
            <article className="metric-card">
              <LockKeyhole size={22} />
              <div>
                <span>Trust boundary</span>
                <strong>Server-side execution</strong>
              </div>
            </article>
            <article className="metric-card muted">
              <PlugZap size={22} />
              <div>
                <span>Client devices</span>
                <strong>
                  {roadex.deviceBridgePolicy
                    ? `${deviceTransportLabel(roadex.browserDeviceCapability.transport)} · ${roadex.deviceBridgePolicy.writeEnabled ? 'verified flash' : roadex.deviceBridgePolicy.descriptorObservationEnabled ? 'observe only' : 'disabled'}`
                    : 'Policy unavailable'}
                </strong>
              </div>
            </article>
          </aside>
        </section>

        <section className="lower-grid">
          <article className="section-card security-card" id="security-checks">
            <div className="panel-heading compact">
              <div>
                <span className="section-label">Oversight</span>
                <h2>Security checks</h2>
              </div>
              <KeyRound size={20} />
            </div>
            <ul className="safeguard-list">
              {(session?.gates ?? []).map((gate) => (
                <li key={gate.id}>
                  {gate.state === 'deferred' ? (
                    <CirclePause size={18} />
                  ) : (
                    <CheckCircle2 size={18} />
                  )}
                  <span>{gate.label}: {gate.state}</span>
                </li>
              ))}
            </ul>
            <div className="safeguard-note">
              {roadex.deviceBridgePolicy?.writeEnabled
                ? 'General device access remains disabled; verified flashing requires fresh approval.'
                : 'Device bridge remains disabled.'}
            </div>
          </article>

          <article className="section-card device-card" id="device-status">
            <div className="panel-heading compact">
              <div>
                <span className="section-label">Audit</span>
                <h2>Latest events</h2>
              </div>
              <RadioTower size={20} />
            </div>
            <div className="audit-list">
              {roadex.auditEvents.map((event) => (
                <div className="audit-row" key={event.id}>
                  <strong>{event.action}</strong>
                  <span>{event.summary}</span>
                </div>
              ))}
            </div>
            <div className="descriptor-observation">
              <div>
                <strong>USB descriptor</strong>
                <span>
                  {roadex.descriptorObservation
                    ? `${formatUsbId(roadex.descriptorObservation.vendorId)}:${formatUsbId(roadex.descriptorObservation.productId)} · observed / ${roadex.descriptorObservation.verification}`
                    : 'No client descriptor observed'}
                </span>
              </div>
              <button
                disabled={!hasBleRuntimeVerification(window.navigator) || bleVerification === 'checking'}
                onClick={() => void handleBleVerification()}
                type="button"
              >
                <RadioTower size={17} />
                {bleVerification === 'checking' ? 'Checking BLE' : 'Verify BLE runtime'}
              </button>
              <button
                disabled={!hasSerialRuntimeVerification(window.navigator) || serialVerification === 'checking'}
                onClick={() => void handleSerialVerification()}
                type="button"
              >
                <TerminalSquare size={17} />
                {serialVerification === 'checking' ? 'Listening for boot' : 'Verify serial boot'}
              </button>
              <button
                disabled={
                  !roadex.deviceBridgePolicy?.descriptorObservationEnabled ||
                  roadex.browserDeviceCapability.transport !== 'webusb' ||
                  !session ||
                  !roadex.deviceInventoryBindingRefs.some((binding) => binding.projectId === session.workspace.id)
                }
                onClick={() => void roadex.observeUsbDescriptor()}
                type="button"
              >
                <PlugZap size={17} />
                Observe USB
              </button>
              <button
                disabled={
                  !roadex.deviceBridgePolicy?.descriptorObservationEnabled ||
                  !roadex.browserDeviceCapability.identityProbeAvailable ||
                  !session ||
                  !roadex.deviceInventoryBindingRefs.some(
                    (binding) => binding.projectId === session.workspace.id && binding.identityVerificationAvailable,
                  )
                }
                onClick={() => void roadex.verifyEsp32Identity()}
                type="button"
              >
                <KeyRound size={17} />
                Verify ESP32
              </button>
              <button
                disabled={
                  !roadex.deviceBridgePolicy?.requestIntakeEnabled ||
                  roadex.descriptorObservation?.verification !== 'verified' ||
                  !session
                }
                onClick={() => void roadex.createProbeApproval()}
                type="button"
              >
                <ShieldCheck size={17} />
                Create probe approval
              </button>
              <button
                disabled={!roadex.pendingProbeApproval}
                onClick={() => void roadex.runControlledProbe()}
                type="button"
              >
                <Activity size={17} />
                Run controlled probe
              </button>
              <button
                disabled={!roadex.pendingProbeConfirmation || roadex.pendingProbeConfirmation.phase !== 'verified'}
                onClick={() => void roadex.confirmControlledProbe()}
                type="button"
              >
                <ShieldCheck size={17} />
                Confirm verified target
              </button>
              <button
                disabled={!roadex.pendingProbeConfirmation || roadex.pendingProbeConfirmation.phase !== 'confirmation'}
                onClick={() => void roadex.loadConfirmedFirmware()}
                type="button"
              >
                <ShieldCheck size={17} />
                Verify firmware bytes
              </button>
              <button
                disabled={
                  !roadex.deviceBridgePolicy?.writeEnabled ||
                  !roadex.verifiedFirmwareReady ||
                  roadex.pendingProbeConfirmation?.phase !== 'confirmation'
                }
                onClick={() => void roadex.flashConfirmedFirmware()}
                type="button"
              >
                <PlugZap size={17} />
                Flash verified firmware
              </button>
              {bleVerificationMessage ? (
                <span className={`device-verification ${bleVerification}`} role={bleVerification === 'error' ? 'alert' : 'status'}>
                  {bleVerificationMessage}
                </span>
              ) : null}
              {serialVerificationMessage ? (
                <span className={`device-verification ${serialVerification}`} role={serialVerification === 'error' ? 'alert' : 'status'}>
                  {serialVerificationMessage}
                </span>
              ) : null}
            </div>
            <div className="timeline-note">
              <Clock3 size={18} />
              <span>{roadex.verifiedFirmwareReady ? 'Firmware is digest-verified in browser memory; device writes remain disabled.' : 'Firmware delivery cannot write to the device.'}</span>
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}

export default App;

function readLayoutPreference(): string | null {
  try {
    return window.localStorage.getItem('roadex-layout-mode');
  } catch {
    return null;
  }
}

function deviceTransportLabel(transport: 'webusb' | 'unavailable'): string {
  if (transport === 'webusb') return 'WebUSB detected';
  return 'Browser unsupported';
}

function formatUsbId(value: number): string {
  return value.toString(16).padStart(4, '0').toUpperCase();
}
