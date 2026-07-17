import {
  Activity,
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
  Server,
  ShieldCheck,
  TerminalSquare,
  UserRoundCheck,
} from 'lucide-react';
import { activeSession, navItems, sessionSummaries } from './roadexModel';

function App() {
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
        <header className="topbar">
          <button className="icon-button" type="button" aria-label="Open menu">
            <Menu size={20} />
          </button>
          <div className="topbar-title">
            <span>Server workspace</span>
            <strong>/srv/roadex/projects/roadex</strong>
          </div>
          <div className="session-pill">
            <Activity size={16} />
            <span>Connected</span>
          </div>
        </header>

        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">Browser-first Codex access</span>
            <h1>Run server-side Codex sessions from any device.</h1>
            <p>
              Roadex gives users a responsive portal for Codex-like work on a
              server: streamed conversation, terminal-style context, project
              visibility, and security controls before sensitive capabilities
              are enabled.
            </p>
          </div>
          <div className="hero-actions">
            <button className="primary-action" type="button">
              <TerminalSquare size={18} />
              <span>Open Session</span>
            </button>
            <button className="secondary-action" type="button">
              <ShieldCheck size={18} />
              <span>Review Gates</span>
            </button>
          </div>
        </section>

        <section className="dashboard-grid" aria-label="Roadex dashboard">
          <article className="codex-panel">
            <div className="panel-heading">
              <div>
                <span className="section-label">Active session</span>
                <h2>Codex conversation stream</h2>
              </div>
              <span className="status-dot">{activeSession.lifecycle}</span>
            </div>

            <div className="transcript">
              <div className="message system">
                <Server size={18} />
                <p>
                  Roadex mock session attached to {activeSession.workspace.root}.
                </p>
              </div>
              <div className="message user">
                <UserRoundCheck size={18} />
                <p>Build the browser portal before enabling client devices.</p>
              </div>
              <div className="message assistant">
                <Bot size={18} />
                <p>
                  Runner mode is {activeSession.runnerMode}; transport is{' '}
                  {activeSession.transport}. Real Codex process integration is
                  blocked until the security gates pass.
                </p>
              </div>
            </div>

            <form className="prompt-row">
              <label className="sr-only" htmlFor="prompt">
                Prompt
              </label>
              <input
                id="prompt"
                placeholder="Send a prompt to the server-side Codex session"
                type="text"
              />
              <button type="button">
                <ChevronRight size={20} />
              </button>
            </form>
          </article>

          <aside className="side-stack">
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
              {sessionSummaries.map((session) => (
                <div className="session-row" key={session.project}>
                  <div>
                    <strong>{session.project}</strong>
                    <span>{session.branch}</span>
                  </div>
                  <p>{session.state}</p>
                  <span className="signal">{session.signal}</span>
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
              {activeSession.gates.map((gate) => (
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
              Controls are tracked in the first portal model.
            </div>
          </article>

          <article className="section-card device-card">
            <div className="panel-heading compact">
              <div>
                <span className="section-label">Later phase</span>
                <h2>Device bridge</h2>
              </div>
              <RadioTower size={20} />
            </div>
            <p>
              Local peripherals remain outside the first app milestone. The
              bridge will need explicit user consent, platform capability
              checks, scoped forwarding, and audited approval before an ESP32 or
              similar device can be exposed to a server-side Codex session.
            </p>
            <div className="timeline-note">
              <Clock3 size={18} />
              <span>Enable only after the portal and security model are verified.</span>
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}

export default App;
