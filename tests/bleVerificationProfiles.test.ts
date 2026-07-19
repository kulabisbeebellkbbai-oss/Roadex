import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadBleVerificationProfiles } from '../src/server/bleVerificationProfiles';

const profile = {
  id: 'ble-runtime', workspaceId: 'project-one', label: 'BLE runtime',
  serviceUuid: '9e9a0001-6f3d-4f57-9e9f-8c2b9a5f1000',
  characteristicUuid: '9e9a0008-6f3d-4f57-9e9f-8c2b9a5f1000',
  timeoutMs: 15000,
  expectedFields: { firmware: '0.1.0', ready: true }, successMessage: 'BLE verified.',
};

describe('BLE verification profile registry', () => {
  it('returns no profiles without configuration and loads a valid profile', () => {
    expect(loadBleVerificationProfiles('')).toEqual([]);
    expect(loadBleVerificationProfiles(writeProfiles([profile]))).toEqual([profile]);
  });

  it('rejects unknown fields, duplicate workspaces, and invalid UUIDs', () => {
    expect(() => loadBleVerificationProfiles(writeProfiles([{ ...profile, extra: true }]))).toThrow('unknown fields');
    expect(() => loadBleVerificationProfiles(writeProfiles([profile, { ...profile, id: 'other' }]))).toThrow('must be unique');
    expect(() => loadBleVerificationProfiles(writeProfiles([{ ...profile, serviceUuid: 'not-a-uuid' }]))).toThrow('serviceUuid is invalid');
  });

  it('rejects oversized files and invalid expected fields before exposure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'roadex-ble-profiles-'));
    const oversized = join(directory, 'oversized.json');
    writeFileSync(oversized, 'x'.repeat(65_537));
    expect(() => loadBleVerificationProfiles(oversized)).toThrow('invalid or oversized');
    expect(() => loadBleVerificationProfiles(writeProfiles([{ ...profile, expectedFields: {} }]))).toThrow('expectedFields is invalid');
    expect(() => loadBleVerificationProfiles(writeProfiles([{
      ...profile,
      expectedFields: Object.fromEntries([['__proto__', true]]),
    }]))).toThrow('expectedFields is invalid');
  });
});

function writeProfiles(profiles: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'roadex-ble-profiles-'));
  const path = join(directory, 'profiles.json');
  writeFileSync(path, JSON.stringify(profiles));
  return path;
}
