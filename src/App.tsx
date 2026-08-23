import { FormEvent, useEffect, useRef, useState } from 'react';
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
  RotateCcw,
  ShieldCheck,
  Smartphone,
  TerminalSquare,
  UserRound,
} from 'lucide-react';
import {
  confirmProjectProposal,
  createProjectProposal,
  requestProjectConfirmation,
  revokeProjectProposal,
} from './client/sessionApi';
import type { ProjectCreationProposalPublic, ProjectVisibility } from './shared/projectCreationContracts';
import { useRoadexSession } from './hooks/useRoadexSession';
import { navItems } from './roadexModel';
import { isVisibleTranscriptEvent, shouldFollowTranscript } from './transcript';
import { resolveLayoutMode, toggleLayoutMode } from './layoutMode';
import { hasBleRuntimeVerification, verifyBleRuntime } from './client/bleRuntimeVerifier';
import { hasSerialRuntimeVerification, verifySerialRuntime } from './client/serialRuntimeVerifier';
import { allowsUsbOperation } from './shared/usbDeviceProfileContracts';
import type { RoadexPolicyExceptionDisplay, WaitingApprovalSummary } from './shared/approvalWorkflowContracts';
import { ProjectHumanThreadPanel } from './ProjectHumanThreadPanel';

function App() {
  const roadex = useRoadexSession();
  const [prompt, setPrompt] = useState('');
  const [sidebarPanel, setSidebarPanel] = useState<'projects' | 'sessions' | 'devices' | 'security'>('projects');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectVisibility, setProjectVisibility] = useState<ProjectVisibility>('private');
  const [projectOutcome, setProjectOutcome] = useState('');
  const [projectUsers, setProjectUsers] = useState('');
  const [projectComponents, setProjectComponents] = useState('');
  const [projectRisks, setProjectRisks] = useState('');
  const [projectNextSteps, setProjectNextSteps] = useState('');
  const [projectTeamId, setProjectTeamId] = useState('');
  const [projectProposal, setProjectProposal] = useState<ProjectCreationProposalPublic>();
  const [projectChallenge, setProjectChallenge] = useState('');
  const [projectCreationError, setProjectCreationError] = useState('');
  const [projectCreationBusy, setProjectCreationBusy] = useState(false);
  const [bleVerification, setBleVerification] = useState<'idle' | 'checking' | 'verified' | 'error'>('idle');
  const [bleVerificationMessage, setBleVerificationMessage] = useState('');
  const bleVerificationSequence = useRef(0);
  const [serialVerification, setSerialVerification] = useState<'idle' | 'checking' | 'verified' | 'error'>('idle');
  const [serialVerificationMessage, setSerialVerificationMessage] = useState('');
  const serialVerificationSequence = useRef(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileView, setMobileView] = useState<'chat' | 'devices' | 'security'>('chat');
  const mobileMenuButton = useRef<HTMLButtonElement>(null);
  const mobileDrawer = useRef<HTMLElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const [layoutMode, setLayoutMode] = useState(() => resolveLayoutMode(
    readLayoutPreference(),
    window.matchMedia('(max-width: 720px)').matches,
  ));
  const session = roadex.session;
  const serialVerificationProfile = roadex.serialVerificationProfiles.find(
    (profile) => profile.workspaceId === session?.workspace.id,
  );
  const bleVerificationProfile = roadex.bleVerificationProfiles.find(
    (profile) => profile.workspaceId === session?.workspace.id,
  );
  const usbDeviceProfile = roadex.usbDeviceProfiles.find(
    (profile) => profile.workspaceId === session?.workspace.id,
  );
  const selectedProject = roadex.workspaces.find(
    (workspace) => workspace.id === (selectedProjectId || session?.workspace.id),
  );
  const selectedProjectHasDeviceProfile = Boolean(selectedProject) && [
    roadex.serialVerificationProfiles,
    roadex.bleVerificationProfiles,
    roadex.usbDeviceProfiles,
  ].some((profiles) => profiles.some((profile) => profile.workspaceId === selectedProject?.id));
  const visibleTranscript = roadex.transcript.filter(isVisibleTranscriptEvent);
  const lastVisibleTranscriptEventId = visibleTranscript[visibleTranscript.length - 1]?.id;
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
  const activeProjectThreads = roadex.sessions
    .filter((candidate) => candidate.workspace.id === selectedProject?.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const selectedRoadexThread = session && session.workspace.id === selectedProject?.id ? `roadex:${session.id}` : '';
  const selectedThreadLabel = roadex.managedThreads.find(
    (candidate) => candidate.id === session?.codexThreadId,
  )?.label ?? (session ? `Thread ${session.id.slice(-8)}` : 'Attaching thread');
  const approvalWait = roadex.approvalWait;
  const approvalConsoleLabel = approvalWait?.consoleSurface === 'admin' ? 'Admin Console' : 'Overview Console';
  const approvalConsolePath = safeApprovalConsolePath(approvalWait);
  const approvalCards = approvalWait ? approvalCopy(approvalWait) : undefined;
  const policyException = approvalWait?.policyException;
  const composerDisabled =
    roadex.connectionState === 'loading' ||
    roadex.connectionState === 'streaming' ||
    roadex.connectionState === 'error' ||
    !session ||
    roadex.approvalComposerBlocked ||
    session.lifecycle !== 'ready';
  const threadIsWorking = roadex.connectionState === 'streaming'
    || session?.lifecycle === 'streaming'
    || session?.runActivity?.status === 'working';
  const canProposeProject = roadex.user?.authMode === 'protected-gateway'
    && roadex.user.roles.includes('admin')
    && roadex.user.roles.includes('security-reviewer')
    && Boolean(session?.managedThreadId);

  async function handleProjectProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const majorComponents = projectLines(projectComponents);
    const risks = projectLines(projectRisks);
    const immediateNextSteps = projectLines(projectNextSteps);
    if (
      !session?.managedThreadId || !projectName.trim() || !projectOutcome.trim()
      || !projectUsers.trim() || !projectTeamId.trim() || !majorComponents.length
      || !risks.length || !immediateNextSteps.length
    ) return;
    setProjectCreationBusy(true);
    setProjectCreationError('');
    try {
      const proposal = await createProjectProposal(roadex.token, {
        sessionId: session.id,
        projectName: projectName.trim(),
        visibility: projectVisibility,
        teamId: projectTeamId.trim(),
        idempotencyKey: crypto.randomUUID(),
        summary: {
          outcome: projectOutcome.trim(),
          primaryUsers: projectUsers.trim(),
          majorComponents,
          risks,
          immediateNextSteps,
        },
      });
      setProjectProposal(proposal);
      const confirmation = await requestProjectConfirmation(roadex.token, proposal.id);
      setProjectChallenge(confirmation.challenge);
    } catch (error) {
      setProjectCreationError(error instanceof Error ? error.message : 'Project proposal failed.');
    } finally {
      setProjectCreationBusy(false);
    }
  }

  async function handleProjectConfirmation() {
    if (!projectProposal || !projectChallenge) return;
    setProjectCreationBusy(true);
    setProjectCreationError('');
    try {
      setProjectProposal(await confirmProjectProposal(roadex.token, projectProposal.id, {
        challenge: projectChallenge,
        idempotencyKey: crypto.randomUUID(),
      }));
      setProjectChallenge('');
    } catch (error) {
      setProjectCreationError(error instanceof Error ? error.message : 'Project confirmation failed.');
    } finally {
      setProjectCreationBusy(false);
    }
  }

  async function handleProjectRevocation() {
    if (!projectProposal) return;
    setProjectCreationBusy(true);
    setProjectCreationError('');
    try {
      setProjectProposal(await revokeProjectProposal(roadex.token, projectProposal.id));
      setProjectChallenge('');
    } catch (error) {
      setProjectCreationError(error instanceof Error ? error.message : 'Project revocation failed.');
    } finally {
      setProjectCreationBusy(false);
    }
  }

  useEffect(() => {
    try {
      window.localStorage.setItem('roadex-layout-mode', layoutMode);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }, [layoutMode]);

  useEffect(() => {
    if (session?.workspace.id) setSelectedProjectId(session.workspace.id);
    followTranscript.current = true;
    setMobileView('chat');
    serialVerificationSequence.current += 1;
    bleVerificationSequence.current += 1;
    setBleVerification('idle');
    setBleVerificationMessage('');
    setSerialVerification('idle');
    setSerialVerificationMessage('');
  }, [session?.id, session?.workspace.id]);

  useEffect(() => {
    if (layoutMode !== 'mobile') setMobileMenuOpen(false);
  }, [layoutMode]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const focusTarget = mobileDrawer.current?.querySelector<HTMLButtonElement>('.nav-item');
    focusTarget?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileMenuOpen(false);
        mobileMenuButton.current?.focus();
        return;
      }
      if (event.key !== 'Tab' || !mobileDrawer.current) return;
      const focusable = [...mobileDrawer.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled])',
      )].filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (!followTranscript.current || !transcript.current) return;
    transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [lastVisibleTranscriptEventId, roadex.connectionState, mobileView]);

  async function handlePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (composerDisabled || !prompt.trim()) return;
    const nextPrompt = prompt;
    followTranscript.current = true;
    setPrompt('');
    await roadex.sendPrompt(nextPrompt);
  }

  function handleMobileMenuClose(restoreFocus = false) {
    setMobileMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => mobileMenuButton.current?.focus());
  }

  function handleNavigation(label: string) {
    if (label === 'Projects') {
      setSidebarPanel('projects');
      return;
    }
    const panel = label.toLowerCase() as 'sessions' | 'devices' | 'security';
    setSidebarPanel(panel);
    if (label === 'Sessions') setMobileView('chat');
    if (label === 'Security') setMobileView('security');
    if (label === 'Devices') setMobileView('devices');
    if (layoutMode === 'mobile') {
      handleMobileMenuClose();
      return;
    }
    if (label === 'Security') document.getElementById('security-checks')?.scrollIntoView({ behavior: 'smooth' });
    if (label === 'Devices') document.getElementById('device-status')?.scrollIntoView({ behavior: 'smooth' });
  }

  async function handleBleVerification() {
    if (!bleVerificationProfile) return;
    const sequence = ++bleVerificationSequence.current;
    setBleVerification('checking');
    setBleVerificationMessage('');
    try {
      await verifyBleRuntime(window.navigator, bleVerificationProfile);
      if (sequence !== bleVerificationSequence.current) return;
      setBleVerification('verified');
      setBleVerificationMessage(bleVerificationProfile.successMessage);
    } catch (error) {
      if (sequence !== bleVerificationSequence.current) return;
      setBleVerification('error');
      setBleVerificationMessage(error instanceof Error ? error.message : 'BLE runtime verification failed.');
    }
  }

  async function handleSerialVerification() {
    if (!serialVerificationProfile || !allowsUsbOperation(usbDeviceProfile, 'serial.verify')) return;
    const sequence = ++serialVerificationSequence.current;
    setSerialVerification('checking');
    setSerialVerificationMessage(`Select the serial device for ${serialVerificationProfile.label}, then reset it while Roadex listens.`);
    try {
      await verifySerialRuntime(window.navigator, serialVerificationProfile, usbDeviceProfile.filters);
      if (sequence !== serialVerificationSequence.current) return;
      setSerialVerification('verified');
      setSerialVerificationMessage(serialVerificationProfile.successMessage);
    } catch (error) {
      if (sequence !== serialVerificationSequence.current) return;
      setSerialVerification('error');
      setSerialVerificationMessage(error instanceof Error ? error.message : 'Serial runtime verification failed.');
    }
  }

  return (
    <main className={`app-shell layout-${layoutMode} mobile-view-${mobileView}`}>
      <aside
        aria-hidden={layoutMode === 'mobile' && !mobileMenuOpen}
        className={`sidebar${mobileMenuOpen ? ' mobile-open' : ''}`}
        id="roadex-navigation"
        ref={mobileDrawer}
        aria-label="Roadex navigation"
      >
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
              onClick={() => handleNavigation(item.label)}
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
                data-testid="project-selector"
                data-profile-configured={selectedProjectHasDeviceProfile}
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
                data-testid="thread-selector"
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
            <div className="thread-actions-list" aria-label="Active thread management">
              {activeProjectThreads.map((candidate) => (
                <div className="thread-action-row" key={candidate.id}>
                  <button
                    className="thread-open-action"
                    onClick={() => void roadex.selectThread(candidate.id)}
                    type="button"
                  >
                    <span>{candidate.id.slice(-8)}</span>
                    <strong>{candidate.lifecycle}</strong>
                  </button>
                  {candidate.lifecycle === 'blocked' || candidate.lifecycle === 'paused' ? (
                    <button
                      aria-label={`Recover thread ${candidate.id.slice(-8)}`}
                      className="thread-icon-action"
                      onClick={() => void roadex.recoverThread(candidate.id)}
                      title="Recover thread"
                      type="button"
                    >
                      <RotateCcw size={16} />
                    </button>
                  ) : <span aria-hidden="true" />}
                  <button
                    aria-label={`Archive thread ${candidate.id.slice(-8)}`}
                    className="thread-icon-action"
                    disabled={candidate.lifecycle === 'streaming'}
                    onClick={() => void roadex.archiveThread(candidate.id)}
                    title={candidate.lifecycle === 'streaming' ? 'Cancel active work before archiving' : 'Archive thread'}
                    type="button"
                  >
                    <Archive size={16} />
                  </button>
                </div>
              ))}
            </div>
            <button
              className="project-create-command"
              disabled={!canProposeProject}
              onClick={() => setProjectFormOpen((open) => !open)}
              type="button"
            >
              <Plus size={16} />
              New project
            </button>
            {projectFormOpen ? (
              <form className="project-create-form" onSubmit={handleProjectProposal}>
                <label>
                  <span>Name</span>
                  <input maxLength={64} onChange={(event) => setProjectName(event.target.value)} required value={projectName} />
                </label>
                <label>
                  <span>Visibility</span>
                  <select onChange={(event) => setProjectVisibility(event.target.value as ProjectVisibility)} value={projectVisibility}>
                    <option value="private">Private</option>
                    <option value="public">Public</option>
                  </select>
                </label>
                <label>
                  <span>Outcome</span>
                  <textarea maxLength={2_000} onChange={(event) => setProjectOutcome(event.target.value)} required value={projectOutcome} />
                </label>
                <label>
                  <span>Primary users</span>
                  <input maxLength={1_000} onChange={(event) => setProjectUsers(event.target.value)} required value={projectUsers} />
                </label>
                <label>
                  <span>Major components</span>
                  <textarea maxLength={2_000} onChange={(event) => setProjectComponents(event.target.value)} placeholder="One per line" required value={projectComponents} />
                </label>
                <label>
                  <span>Risks</span>
                  <textarea maxLength={2_000} onChange={(event) => setProjectRisks(event.target.value)} placeholder="One per line" required value={projectRisks} />
                </label>
                <label>
                  <span>Immediate next steps</span>
                  <textarea maxLength={2_000} onChange={(event) => setProjectNextSteps(event.target.value)} placeholder="One per line" required value={projectNextSteps} />
                </label>
                <label>
                  <span>Approved A-Team ID</span>
                  <input maxLength={128} onChange={(event) => setProjectTeamId(event.target.value)} required value={projectTeamId} />
                </label>
                {!projectProposal ? (
                  <button disabled={projectCreationBusy} type="submit">Review proposal</button>
                ) : (
                  <div className="project-confirmation" role="status">
                    <strong>{projectProposal.projectName}</strong>
                    <span>{projectProposal.visibility} · {projectProposal.status}</span>
                    {projectChallenge ? <p>Confirming creates a local project and public or private GitHub repository. This action can have external side effects.</p> : null}
                    <div>
                      {projectChallenge ? (
                        <button disabled={projectCreationBusy} onClick={() => void handleProjectConfirmation()} type="button">Confirm creation</button>
                      ) : null}
                      {projectProposal.status === 'pending' ? (
                        <button disabled={projectCreationBusy} onClick={() => void handleProjectRevocation()} type="button">Revoke</button>
                      ) : null}
                    </div>
                  </div>
                )}
                {projectCreationError ? <p className="project-create-error" role="alert">{projectCreationError}</p> : null}
              </form>
            ) : null}
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
      <button
        aria-label="Close navigation"
        className={`mobile-drawer-backdrop${mobileMenuOpen ? ' visible' : ''}`}
        onClick={() => handleMobileMenuClose(true)}
        tabIndex={mobileMenuOpen ? 0 : -1}
        type="button"
      />

      <section className="workspace">
        <header className="topbar session-topbar">
          <button
            aria-controls="roadex-navigation"
            aria-expanded={mobileMenuOpen}
            aria-label="Open navigation and controls"
            className="icon-button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            ref={mobileMenuButton}
            type="button"
          >
            <Menu size={20} />
          </button>
          <div className="topbar-title">
            <span className="desktop-title">{roadex.user?.displayName ?? 'Attaching user'}</span>
            <strong className="desktop-title" title={session?.workspace.root}>
              {session?.workspace.root ?? '/srv/roadex/projects/...'}
            </strong>
            <span className="mobile-title">{session?.workspace.name ?? 'Roadex'}</span>
            <strong className="mobile-title">{selectedThreadLabel}</strong>
          </div>
          <div
            aria-live="polite"
            className={`session-pill${approvalWait ? ' approval' : ''}`}
            role="status"
          >
            {approvalWait ? <Clock3 size={16} /> : <Activity size={16} />}
            <span>{approvalWait ? `Awaiting human approval (${approvalConsoleLabel})` : threadIsWorking ? 'Working' : roadex.connectionState}</span>
          </div>
          <button
            data-testid="layout-toggle"
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

        <ProjectHumanThreadPanel
          key={`${selectedProject?.id ?? 'none'}:${selectedProject?.root ?? 'none'}`}
          token={roadex.token}
          project={selectedProject}
          onOpenConversation={(conversationId) => {
            const attached = [...roadex.sessions, ...roadex.archivedSessions].find((candidate) => (
              candidate.workspace.id === selectedProject?.id
              && (candidate.id === conversationId || candidate.codexThreadId === conversationId)
            ));
            if (attached && attached.lifecycle !== 'closed') {
              void roadex.selectThread(attached.id);
              return;
            }
            const managed = roadex.managedThreads.find((candidate) => (
              candidate.project.id === selectedProject?.id && candidate.id === conversationId
            ));
            if (managed && selectedProject) void roadex.attachManagedThread(managed.id, selectedProject.id);
          }}
        />

        <section className="dashboard-grid live-grid" aria-label="Roadex dashboard">
          <article className="codex-panel">
            <div className="panel-heading">
              <div>
                <span className="section-label">Active stream</span>
                <h2>Transcript</h2>
              </div>
              <span
                aria-live="polite"
                className={`status-dot${threadIsWorking ? ' working' : ''}`}
                role="status"
              >
                {threadIsWorking ? 'Working' : session?.lifecycle ?? 'loading'}
              </span>
            </div>

            {approvalWait && approvalCards ? (
              <section
                aria-label="Human approval required"
                className={`approval-wait approval-${approvalWait.state}`}
                role="status"
              >
                <div className="approval-wait-heading">
                  <span className="section-label">Human approval required</span>
                  <strong>{approvalCards.heading}</strong>
                </div>
                {approvalCards.body.map((line) => <p key={line}>{line}</p>)}
                <code>Approval reference: {approvalWait.approvalRef}</code>
                {approvalConsolePath ? <a className="approval-wait-link" href={approvalConsolePath}>Open {approvalConsoleLabel}</a> : null}
              </section>
            ) : null}

            <div
              aria-label="Conversation history"
              aria-live="polite"
              className="transcript"
              onScroll={(event) => {
                const target = event.currentTarget;
                followTranscript.current = shouldFollowTranscript(
                  target.scrollHeight,
                  target.scrollTop,
                  target.clientHeight,
                );
              }}
              ref={transcript}
              tabIndex={0}
            >
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
            {policyException ? <PolicyExceptionCard projection={policyException} /> : null}
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
                data-testid="verify-ble"
                data-profile-configured={Boolean(bleVerificationProfile)}
                data-runtime-available={hasBleRuntimeVerification(window.navigator)}
                disabled={!hasBleRuntimeVerification(window.navigator) || !bleVerificationProfile || bleVerification === 'checking'}
                onClick={() => void handleBleVerification()}
                type="button"
                title={bleVerificationProfile ? `Run ${bleVerificationProfile.label}` : 'No BLE verification profile is configured for this project'}
              >
                <RadioTower size={17} />
                {bleVerification === 'checking' ? 'Checking BLE' : 'Verify BLE runtime'}
              </button>
              <button
                data-testid="verify-serial"
                data-profile-configured={Boolean(serialVerificationProfile && allowsUsbOperation(usbDeviceProfile, 'serial.verify'))}
                data-runtime-available={hasSerialRuntimeVerification(window.navigator)}
                disabled={!hasSerialRuntimeVerification(window.navigator) || !serialVerificationProfile || !allowsUsbOperation(usbDeviceProfile, 'serial.verify') || serialVerification === 'checking'}
                onClick={() => void handleSerialVerification()}
                type="button"
                title={serialVerificationProfile ? `Run ${serialVerificationProfile.label}` : 'No serial verification profile is configured for this project'}
              >
                <TerminalSquare size={17} />
                {serialVerification === 'checking' ? 'Listening for runtime' : 'Verify serial runtime'}
              </button>
              <button
                data-testid="observe-usb"
                data-binding-ready={Boolean(session && roadex.deviceInventoryBindingRefs.some((binding) => binding.projectId === session.workspace.id))}
                data-policy-ready={Boolean(roadex.deviceBridgePolicy?.descriptorObservationEnabled)}
                data-profile-configured={allowsUsbOperation(usbDeviceProfile, 'observe')}
                data-runtime-available={roadex.browserDeviceCapability.transport === 'webusb'}
                disabled={
                  !roadex.deviceBridgePolicy?.descriptorObservationEnabled ||
                  roadex.browserDeviceCapability.transport !== 'webusb' ||
                  !session ||
                  !allowsUsbOperation(usbDeviceProfile, 'observe') ||
                  !roadex.deviceInventoryBindingRefs.some((binding) => binding.projectId === session.workspace.id)
                }
                onClick={() => void roadex.observeUsbDescriptor()}
                type="button"
              >
                <PlugZap size={17} />
                Observe USB
              </button>
              <button
                data-testid="verify-esp32"
                data-binding-ready={Boolean(session && roadex.deviceInventoryBindingRefs.some(
                  (binding) => binding.projectId === session.workspace.id && binding.identityVerificationAvailable,
                ))}
                data-policy-ready={Boolean(roadex.deviceBridgePolicy?.descriptorObservationEnabled)}
                data-profile-configured={allowsUsbOperation(usbDeviceProfile, 'esp32.identity')}
                data-runtime-available={roadex.browserDeviceCapability.identityProbeAvailable}
                disabled={
                  !roadex.deviceBridgePolicy?.descriptorObservationEnabled ||
                  !roadex.browserDeviceCapability.identityProbeAvailable ||
                  !session ||
                  !allowsUsbOperation(usbDeviceProfile, 'esp32.identity') ||
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
                data-testid="create-probe-approval"
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
                data-testid="run-controlled-probe"
                disabled={!roadex.pendingProbeApproval}
                onClick={() => void roadex.runControlledProbe()}
                type="button"
              >
                <Activity size={17} />
                Run controlled probe
              </button>
              <button
                data-testid="confirm-verified-target"
                disabled={!roadex.pendingProbeConfirmation || roadex.pendingProbeConfirmation.phase !== 'verified'}
                onClick={() => void roadex.confirmControlledProbe()}
                type="button"
              >
                <ShieldCheck size={17} />
                Confirm verified target
              </button>
              <button
                data-testid="verify-firmware-bytes"
                disabled={!roadex.pendingProbeConfirmation || roadex.pendingProbeConfirmation.phase !== 'confirmation'}
                onClick={() => void roadex.loadConfirmedFirmware()}
                type="button"
              >
                <ShieldCheck size={17} />
                Verify firmware bytes
              </button>
              <button
                data-testid="flash-firmware"
                data-confirmation-ready={roadex.pendingProbeConfirmation?.phase === 'confirmation'}
                data-firmware-ready={roadex.verifiedFirmwareReady}
                data-policy-ready={Boolean(roadex.deviceBridgePolicy?.writeEnabled)}
                data-profile-configured={allowsUsbOperation(usbDeviceProfile, 'esp32.flash')}
                disabled={
                  !roadex.deviceBridgePolicy?.writeEnabled ||
                  !roadex.verifiedFirmwareReady ||
                  roadex.pendingProbeConfirmation?.phase !== 'confirmation'
                  || !allowsUsbOperation(usbDeviceProfile, 'esp32.flash')
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

function approvalCopy(wait: WaitingApprovalSummary): {
  heading: string;
  body: string[];
} {
  switch (wait.state) {
    case 'pending': {
      return {
        heading: 'This thread is safely paused.',
        body: [
          `Approve ${wait.subject} in the ${wait.consoleSurface === 'admin' ? 'Admin Console' : 'Overview Console'}.`,
          'Roadex will continue automatically after approval is verified.',
        ],
      };
    }
    case 'verification-delayed': {
      return {
        heading: 'Approval verification is delayed.',
        body: [
          `Roadex has not rechecked ${wait.subject} yet.`,
          'Roadex will continue automatically after approval is verified.',
        ],
      };
    }
    case 'security-failure': {
      return {
        heading: 'Approval could not be validated safely.',
        body: [
          `Roadex could not verify the approval binding for ${wait.subject}.`,
          'This thread remains paused and will not continue automatically.',
        ],
      };
    }
    case 'approved-resume-queued': {
      return {
        heading: 'Approval granted - resuming automatically.',
        body: [
          `Approval for ${wait.subject} is recorded in the ${wait.consoleSurface === 'admin' ? 'Admin Console' : 'Overview Console'}.`,
          'Waiting for runner capacity.',
        ],
      };
    }
    case 'resume-dispatching': {
      return {
        heading: 'Approval granted - resuming automatically.',
        body: [
          `Dispatching the continuation for ${wait.subject}.`,
          'Roadex is continuing the managed thread automatically.',
        ],
      };
    }
    case 'resume-reconciliation-required': {
      return {
        heading: 'Approval granted - resuming automatically.',
        body: [
          `Approval for ${wait.subject} remains recorded.`,
          'Approval remains recorded, but an operator must verify whether the exact continuation was accepted.',
        ],
      };
    }
    default:
      return {
        heading: 'This thread is safely paused.',
        body: ['Roadex will continue automatically after approval is verified.'],
      };
  }
}

function safeApprovalConsolePath(wait: WaitingApprovalSummary | undefined): string | undefined {
  if (!wait?.consolePath) return undefined;
  const deploymentPath = wait.consoleSurface === 'admin'
    ? '/Overseer/admin'
    : '/Overseer/overview';
  return wait.consolePath === deploymentPath ? deploymentPath : undefined;
}

function PolicyExceptionCard({ projection }: { projection: RoadexPolicyExceptionDisplay }) {
  const requestedEffect = typeof projection.requestedValue === 'boolean'
    ? projection.requestedValue ? 'enabled' : 'disabled'
    : String(projection.requestedValue);
  return (
    <section className={`policy-exception policy-exception-${projection.status}`} aria-label="Psychlo policy exception">
      <div className="panel-heading compact">
        <div>
          <span className="section-label">Read-only authority projection</span>
          <h3>Psychlo policy exception</h3>
        </div>
        <ShieldCheck size={18} />
      </div>
      <dl className="policy-exception-details">
        <div><dt>Rule</dt><dd>{projection.ruleId}</dd></div>
        <div><dt>Prior revision</dt><dd>{projection.priorPolicyRevision}</dd></div>
        <div><dt>Requested effect</dt><dd>{requestedEffect}</dd></div>
        <div><dt>Expiry</dt><dd>{projection.expiresAt}</dd></div>
        <div><dt>Status</dt><dd>{projection.status}</dd></div>
      </dl>
      {projection.consolePath === '/Overseer/overview' ? (
        <a className="approval-wait-link" href="/Overseer/overview">Open Overview Console</a>
      ) : null}
      <p className="policy-exception-note">Roadex can display this authority but cannot create, approve, or mutate it.</p>
    </section>
  );
}

function deviceTransportLabel(transport: 'webusb' | 'unavailable'): string {
  if (transport === 'webusb') return 'WebUSB detected';
  return 'Browser unsupported';
}

function formatUsbId(value: number): string {
  return value.toString(16).padStart(4, '0').toUpperCase();
}

function projectLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
