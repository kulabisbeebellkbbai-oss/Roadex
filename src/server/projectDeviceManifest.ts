import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LoadedProjectDeviceProfiles } from '../shared/projectDeviceManifestContracts.js';
import { validateBleVerificationProfile } from './bleVerificationProfiles.js';
import { validateSerialVerificationProfile } from './serialVerificationProfiles.js';
import { validateUsbDeviceProfile } from './usbDeviceProfiles.js';

const workspaceIdPattern = /^[A-Za-z0-9._-]{1,128}$/;
const maxManifestFileBytes = 65_536;
const maxProjects = 32;

export function loadProjectDeviceManifest(
  filePath = process.env.ROADEX_PROJECT_DEVICE_MANIFEST_FILE,
): LoadedProjectDeviceProfiles {
  rejectLegacyConfiguration();
  if (!filePath) return emptyProfiles();

  const parsed = parseJsonWithoutDuplicateKeys(readSecureManifest(resolve(filePath)));
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== 'version' && key !== 'projects')) {
    throw new Error('Project device manifest has unknown fields or is not an object.');
  }
  if (parsed.version !== 1) throw new Error('Project device manifest version is unsupported.');
  if (!Array.isArray(parsed.projects) || parsed.projects.length > maxProjects) {
    throw new Error('Project device manifest projects must be a bounded array.');
  }

  const loaded = emptyProfiles();
  const workspaces = new Set<string>();
  const usbIds = new Set<string>();
  const serialIds = new Set<string>();
  const bleIds = new Set<string>();
  for (const [index, project] of parsed.projects.entries()) {
    if (!isRecord(project) || Object.keys(project).some((key) => !['workspaceId', 'usb', 'serial', 'ble'].includes(key))) {
      throw new Error(`Project device manifest project ${index} is invalid or has unknown fields.`);
    }
    if (typeof project.workspaceId !== 'string' || !workspaceIdPattern.test(project.workspaceId)) {
      throw new Error(`Project device manifest project ${index} workspaceId is invalid.`);
    }
    if (workspaces.has(project.workspaceId)) throw new Error('Project device manifest workspace IDs must be unique.');
    workspaces.add(project.workspaceId);
    if (project.usb === undefined && project.serial === undefined && project.ble === undefined) {
      throw new Error(`Project device manifest project ${index} must configure at least one device capability.`);
    }

    const usb = project.usb === undefined
      ? undefined
      : validateUsbDeviceProfile(withWorkspace(project.usb, project.workspaceId, 'USB', index), index);
    const serial = project.serial === undefined
      ? undefined
      : validateSerialVerificationProfile(withWorkspace(project.serial, project.workspaceId, 'serial', index), index);
    const ble = project.ble === undefined
      ? undefined
      : validateBleVerificationProfile(withWorkspace(project.ble, project.workspaceId, 'BLE', index), index);

    if (serial && (!usb || !usb.operations.includes('serial.verify'))) {
      throw new Error(`Project device manifest project ${index} serial verification requires an allowed USB serial.verify operation.`);
    }
    if (usb) {
      requireUniqueProfileId(usbIds, usb.id, 'USB');
      loaded.usbDeviceProfiles.push(usb);
    }
    if (serial) {
      requireUniqueProfileId(serialIds, serial.id, 'serial');
      loaded.serialVerificationProfiles.push(serial);
    }
    if (ble) {
      requireUniqueProfileId(bleIds, ble.id, 'BLE');
      loaded.bleVerificationProfiles.push(ble);
    }
  }

  return loaded;
}

function readSecureManifest(filePath: string): unknown {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    const ownerAllowed = before.uid === process.getuid?.() || before.uid === 0;
    if (!before.isFile() || !ownerAllowed || (before.mode & 0o022) !== 0 || before.size > maxManifestFileBytes) {
      throw new Error('Project device manifest file is invalid, insecure, or oversized.');
    }
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Project device manifest changed while being read.');
    }
    return bytes.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Project device manifest')) throw error;
    throw new Error('Project device manifest file is invalid, insecure, or unavailable.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function rejectLegacyConfiguration(): void {
  const legacyVariables = [
    'ROADEX_SERIAL_VERIFICATION_PROFILES_FILE',
    'ROADEX_BLE_VERIFICATION_PROFILES_FILE',
    'ROADEX_USB_DEVICE_PROFILES_FILE',
  ];
  if (legacyVariables.some((name) => Boolean(process.env[name]))) {
    throw new Error('Legacy device profile environment variables are not supported; use the project device manifest.');
  }
}

function parseJsonWithoutDuplicateKeys(source: unknown): unknown {
  if (typeof source !== 'string') throw new Error('Project device manifest content is invalid.');
  let position = 0;

  const skipWhitespace = () => {
    while (/\s/.test(source[position] ?? '')) position += 1;
  };
  const parseString = (): string => {
    const start = position;
    if (source[position] !== '"') throw new Error('Project device manifest JSON is invalid.');
    position += 1;
    while (position < source.length) {
      if (source[position] === '\\') {
        position += 2;
      } else if (source[position] === '"') {
        position += 1;
        return JSON.parse(source.slice(start, position)) as string;
      } else {
        position += 1;
      }
    }
    throw new Error('Project device manifest JSON is invalid.');
  };
  const parseValue = (depth: number): void => {
    if (depth > 64) throw new Error('Project device manifest JSON nesting is excessive.');
    skipWhitespace();
    if (source[position] === '{') {
      position += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (source[position] === '}') { position += 1; return; }
      while (position < source.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new Error(`Project device manifest JSON contains duplicate key ${JSON.stringify(key)}.`);
        keys.add(key);
        skipWhitespace();
        if (source[position] !== ':') throw new Error('Project device manifest JSON is invalid.');
        position += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (source[position] === '}') { position += 1; return; }
        if (source[position] !== ',') throw new Error('Project device manifest JSON is invalid.');
        position += 1;
      }
      throw new Error('Project device manifest JSON is invalid.');
    }
    if (source[position] === '[') {
      position += 1;
      skipWhitespace();
      if (source[position] === ']') { position += 1; return; }
      while (position < source.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (source[position] === ']') { position += 1; return; }
        if (source[position] !== ',') throw new Error('Project device manifest JSON is invalid.');
        position += 1;
      }
      throw new Error('Project device manifest JSON is invalid.');
    }
    if (source[position] === '"') { parseString(); return; }
    const token = source.slice(position).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new Error('Project device manifest JSON is invalid.');
    position += token.length;
  };

  parseValue(0);
  skipWhitespace();
  if (position !== source.length) throw new Error('Project device manifest JSON is invalid.');
  return JSON.parse(source) as unknown;
}

function withWorkspace(value: unknown, workspaceId: string, section: string, index: number): Record<string, unknown> {
  if (!isRecord(value) || Object.hasOwn(value, 'workspaceId')) {
    throw new Error(`Project device manifest project ${index} ${section} section is invalid.`);
  }
  return { ...value, workspaceId };
}

function emptyProfiles(): LoadedProjectDeviceProfiles {
  return { serialVerificationProfiles: [], bleVerificationProfiles: [], usbDeviceProfiles: [] };
}

function requireUniqueProfileId(ids: Set<string>, id: string, section: string): void {
  if (ids.has(id)) throw new Error(`Project device manifest ${section} profile IDs must be unique.`);
  ids.add(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
