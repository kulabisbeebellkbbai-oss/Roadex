import { FormEvent, useState } from 'react';
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
  Laptop,
  LockKeyhole,
  Menu,
  MonitorSmartphone,
  PlugZap,
  RadioTower,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import { useRoadexSession } from './hooks/useRoadexSession';
import { navItems } from './roadexModel';

function App() {
  const roadex = useRoadexSession();
  const [prompt, setPrompt] = useState('');
  const session = roadex.session;
  const composerDisabled =
    roadex.connectionState === 'loading' ||
    roadex.connectionState === 'streaming' ||
    roadex.connectionState === 'error' ||
    !session ||
    session.lifecycle !== 'ready';

  async function handlePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (composerDisabled || !prompt.trim()) return;
    const nextPrompt = prompt;
    setPrompt('');
    await roadex.sendPrompt(nextPrompt);
  }

  return (
    <main className="app-shell">
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
              className={`nav-item${item.active ? ' active' : ''}`}
              key={item.label}
              type="button"
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

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

              {roadex.transcript.map((event) => (
                <div className={`message ${event.kind}`} key={event.id}>
                  {event.kind === 'assistant' ? <Bot size={18} /> : <TerminalSquare size={18} />}
                  <p>{event.message}</p>
                </div>
              ))}

              {roadex.transcript.length === 0 && roadex.connectionState === 'connected' ? (
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
                <strong>Deferred until review</strong>
              </div>
            </article>
          </aside>
        </section>

        <section className="lower-grid">
          <article className="section-card">
            <div className="panel-heading compact">
              <div>
                <span className="section-label">Projects</span>
                <h2>Server workspaces</h2>
              </div>
              <Laptop size={20} />
            </div>
            <div className="session-list">
              {roadex.workspaces.map((workspace) => (
                <div className="session-row" key={workspace.id}>
                  <div>
                    <strong>{workspace.name}</strong>
                    <span>{workspace.id}</span>
                  </div>
                  <p title={workspace.root}>{workspace.root}</p>
                  {session?.workspace.id === workspace.id ? (
                    <span className="signal">Active</span>
                  ) : (
                    <button
                      className="inline-action"
                      disabled={roadex.connectionState === 'loading' || roadex.connectionState === 'streaming'}
                      onClick={() => void roadex.openWorkspace(workspace.id)}
                      type="button"
                    >
                      Open
                    </button>
                  )}
                </div>
              ))}
            </div>
          </article>

          <article className="section-card security-card">
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
            <div className="safeguard-note">Device bridge remains disabled.</div>
          </article>

          <article className="section-card device-card">
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
            <div className="timeline-note">
              <Clock3 size={18} />
              <span>Device bridge approval is a later security-reviewed phase.</span>
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}

export default App;
