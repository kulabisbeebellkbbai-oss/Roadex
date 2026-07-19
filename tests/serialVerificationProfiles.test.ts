import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadSerialVerificationProfiles } from '../src/server/serialVerificationProfiles';

const validProfile = {
  id: 'runtime-check',
  workspaceId: 'project-one',
  label: 'Runtime check',
  baudRate: 115200,
  bufferSize: 8192,
  timeoutMs: 15000,
  requiredMarkers: ['runtime ready'],
  successMessage: 'Runtime verified.',
  stages: [{ marker: 'runtime entering', pendingLabel: 'starting the runtime' }],
};

describe('serial verification profile registry', () => {
  it('returns no profiles when configuration is absent', () => {
    expect(loadSerialVerificationProfiles('')).toEqual([]);
  });

  it('loads a bounded project profile', () => {
    const path = writeProfiles([validProfile]);
    expect(loadSerialVerificationProfiles(path)).toEqual([validProfile]);
  });

  it('rejects unknown fields and duplicate workspace profiles', () => {
    expect(() => loadSerialVerificationProfiles(writeProfiles([{ ...validProfile, extra: true }]))).toThrow('unknown fields');
    expect(() => loadSerialVerificationProfiles(writeProfiles([
      validProfile,
      { ...validProfile, id: 'runtime-check-two' },
    ]))).toThrow('must be unique');
  });

  it('rejects control characters, oversized collections, and unsafe numeric bounds', () => {
    expect(() => loadSerialVerificationProfiles(writeProfiles([{ ...validProfile, successMessage: 'bad\nmessage' }]))).toThrow('successMessage is invalid');
    expect(() => loadSerialVerificationProfiles(writeProfiles([{ ...validProfile, requiredMarkers: Array(17).fill('marker') }]))).toThrow('bounded array');
    expect(() => loadSerialVerificationProfiles(writeProfiles([{ ...validProfile, bufferSize: 1 }]))).toThrow('bufferSize is invalid');
  });

  it('rejects an oversized file before JSON parsing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'roadex-serial-profiles-'));
    const path = join(directory, 'profiles.json');
    writeFileSync(path, 'x'.repeat(65_537));

    expect(() => loadSerialVerificationProfiles(path)).toThrow('invalid or oversized');
  });
});

function writeProfiles(profiles: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'roadex-serial-profiles-'));
  const path = join(directory, 'profiles.json');
  writeFileSync(path, JSON.stringify(profiles));
  return path;
}
