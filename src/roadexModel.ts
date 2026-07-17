import {
  Activity,
  FileCode2,
  PlugZap,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { firstMilestoneGates, type RoadexSession, type WorkspaceRef } from './shared/sessionContracts';

export type NavItem = {
  label: string;
  icon: LucideIcon;
  active?: boolean;
};

export type SessionSummary = {
  project: string;
  branch: string;
  state: string;
  signal: string;
};

export const activeWorkspace: WorkspaceRef = {
  id: 'roadex',
  name: 'Roadex Portal',
  root: '/srv/roadex/projects/roadex',
};

export const activeSession: RoadexSession = getActiveMockSession();

export const navItems: NavItem[] = [
  { label: 'Sessions', icon: TerminalSquare, active: true },
  { label: 'Projects', icon: FileCode2 },
  { label: 'Security', icon: ShieldCheck },
  { label: 'Devices', icon: PlugZap },
];

export const sessionSummaries: SessionSummary[] = [
  {
    project: 'Roadex Portal',
    branch: 'main',
    state: 'Designing browser shell',
    signal: 'Live',
  },
  {
    project: 'Firmware Lab',
    branch: 'esp32-poc',
    state: 'Paused until device bridge',
    signal: 'Deferred',
  },
];

export const safeguards = [
  'Authenticated access before session creation',
  'Per-user workspace isolation',
  'Audited command and approval history',
  'Sensitive actions routed through review gates',
];

export const portalTargets = [
  { label: 'Connection state', value: 'Connected', icon: Activity },
  { label: 'Responsive target', value: 'Desktop, tablet, mobile' },
  { label: 'Trust boundary', value: 'Server-side execution' },
  { label: 'Client devices', value: 'Deferred until review' },
];

function getActiveMockSession(): RoadexSession {
  return {
    id: `mock-${activeWorkspace.id}`,
    userId: 'demo-user',
    workspace: activeWorkspace,
    lifecycle: 'ready',
    runnerMode: 'mock',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: firstMilestoneGates.map((gate) => ({
      ...gate,
      state: gate.id === 'device-bridge' ? 'deferred' : 'passed',
    })),
  };
}
