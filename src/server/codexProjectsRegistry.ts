import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { parse } from 'csv-parse/sync';
import type { ManagedCodexThread, WorkspaceRef } from '../shared/sessionContracts.js';

type RegistryRow = {
  conversation_id?: string;
  label?: string;
  project?: string;
  created_at?: string;
  updated_at?: string;
};

type RegistryOptions = {
  registryPath?: string;
  allowedRoots?: string[];
};

const DEFAULT_REGISTRY = '/home/god/.codex/codex-projects.csv';
const DEFAULT_ALLOWED_ROOTS = [
  '/home/god/Documents/Codex Workspace',
  '/home/god/Documents/Private AI Memory Storage System',
  '/home/god/Inventory',
];
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_REGISTRY_ROWS = 5_000;
let registryCache: { key: string; threads: ManagedCodexThread[] } | undefined;

export function loadManagedCodexThreads(options: RegistryOptions = {}): ManagedCodexThread[] {
  const registryPath = options.registryPath ?? process.env.ROADEX_CODEX_PROJECTS_REGISTRY ?? DEFAULT_REGISTRY;
  const allowedRoots = (options.allowedRoots ?? DEFAULT_ALLOWED_ROOTS).map(canonicalPath);
  const metadata = statSync(registryPath);
  if (!metadata.isFile() || metadata.size > MAX_REGISTRY_BYTES) {
    throw new Error('Codex Projects registry exceeds the supported size.');
  }
  const cacheKey = `${registryPath}:${metadata.mtimeMs}:${metadata.size}:${allowedRoots.join('|')}`;
  if (registryCache?.key === cacheKey) return registryCache.threads.map(cloneThread);
  const rows = parse(readFileSync(registryPath, 'utf8'), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as RegistryRow[];
  if (rows.length > MAX_REGISTRY_ROWS) throw new Error('Codex Projects registry contains too many rows.');
  const threads = new Map<string, ManagedCodexThread>();

  for (const row of rows) {
    const conversationId = row.conversation_id?.trim();
    if (!conversationId || !CONVERSATION_ID.test(conversationId) || !row.project) continue;
    let projectRoot: string;
    try {
      projectRoot = canonicalPath(row.project);
    } catch {
      continue;
    }
    if (!allowedRoots.some((root) => isWithinRoot(projectRoot, root))) continue;
    const workspace = workspaceForProject(projectRoot);
    threads.set(conversationId, {
      id: conversationId,
      label: sanitizeLabel(row.label),
      project: workspace,
      createdAt: validTimestamp(row.created_at),
      updatedAt: validTimestamp(row.updated_at),
    });
  }

  const result = [...threads.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  registryCache = { key: cacheKey, threads: result.map(cloneThread) };
  return result;
}

export function managedCodexWorkspaces(options: RegistryOptions = {}): WorkspaceRef[] {
  const workspaces = new Map<string, WorkspaceRef>();
  for (const thread of loadManagedCodexThreads(options)) {
    workspaces.set(thread.project.root, thread.project);
  }
  return [...workspaces.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function workspaceForProject(root: string): WorkspaceRef {
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 8);
  return {
    id: `codex-project-${slug}-${digest}`,
    name: basename(root),
    root,
  };
}

function canonicalPath(path: string): string {
  return realpathSync(resolve(path));
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function sanitizeLabel(value?: string): string {
  const label = (value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (label || 'Untitled Codex thread').slice(0, 160);
}

function validTimestamp(value?: string): string {
  if (!value) return new Date(0).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date(0).toISOString() : parsed.toISOString();
}

function cloneThread(thread: ManagedCodexThread): ManagedCodexThread {
  return { ...thread, project: { ...thread.project } };
}
