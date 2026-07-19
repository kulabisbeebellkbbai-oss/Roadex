import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SerialVerificationProfile } from '../shared/serialVerificationContracts.js';

const idPattern = /^[A-Za-z0-9._-]{1,128}$/;
const printablePattern = /^[\x20-\x7e]+$/;
const maxProfileFileBytes = 65_536;

export function loadSerialVerificationProfiles(
  filePath = process.env.ROADEX_SERIAL_VERIFICATION_PROFILES_FILE,
): SerialVerificationProfile[] {
  if (!filePath) return [];
  const resolvedPath = resolve(filePath);
  const metadata = statSync(resolvedPath);
  if (!metadata.isFile() || metadata.size > maxProfileFileBytes) {
    throw new Error('Serial verification profile file is invalid or oversized.');
  }
  const parsed: unknown = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length > 32) throw new Error('Serial verification profiles must be a bounded array.');
  const profiles = parsed.map(validateProfile);
  const ids = new Set<string>();
  const workspaces = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id) || workspaces.has(profile.workspaceId)) {
      throw new Error('Serial verification profile IDs and workspace IDs must be unique.');
    }
    ids.add(profile.id);
    workspaces.add(profile.workspaceId);
  }
  return profiles;
}

function validateProfile(value: unknown, index: number): SerialVerificationProfile {
  if (!isRecord(value)) throw new Error(`Serial verification profile ${index} must be an object.`);
  const allowed = new Set([
    'id', 'workspaceId', 'label', 'baudRate', 'bufferSize', 'timeoutMs',
    'requiredMarkers', 'successMessage', 'stages',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`Serial verification profile ${index} has unknown fields.`);
  const requiredMarkers = validateStringArray(value.requiredMarkers, 'requiredMarkers', 16, 128);
  if (requiredMarkers.length === 0) throw new Error(`Serial verification profile ${index} requires at least one success marker.`);
  if (!Array.isArray(value.stages) || value.stages.length > 16) throw new Error(`Serial verification profile ${index} stages are invalid.`);
  const stages = value.stages.map((stage, stageIndex) => {
    if (!isRecord(stage) || Object.keys(stage).some((key) => key !== 'marker' && key !== 'pendingLabel')) {
      throw new Error(`Serial verification profile ${index} stage ${stageIndex} is invalid.`);
    }
    return {
      marker: boundedText(stage.marker, 'stage marker', 128),
      pendingLabel: boundedText(stage.pendingLabel, 'stage label', 160),
    };
  });
  const markers = [...requiredMarkers, ...stages.map((stage) => stage.marker)];
  if (new Set(markers).size !== markers.length) throw new Error(`Serial verification profile ${index} markers must be unique.`);
  return {
    id: boundedId(value.id, 'profile id'),
    workspaceId: boundedId(value.workspaceId, 'workspace id'),
    label: boundedText(value.label, 'profile label', 80),
    baudRate: boundedInteger(value.baudRate, 'baudRate', 1_200, 2_000_000),
    bufferSize: boundedInteger(value.bufferSize, 'bufferSize', 256, 65_536),
    timeoutMs: boundedInteger(value.timeoutMs, 'timeoutMs', 1_000, 60_000),
    requiredMarkers,
    successMessage: boundedText(value.successMessage, 'successMessage', 200),
    stages,
  };
}

function validateStringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} must be a bounded array.`);
  return value.map((item) => boundedText(item, field, maxLength));
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !printablePattern.test(value)) {
    throw new Error(`${field} is invalid.`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} is invalid.`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
