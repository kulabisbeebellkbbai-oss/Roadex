import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadUsbDeviceProfiles } from '../src/server/usbDeviceProfiles';

const profile = {
  id: 'usb-devices', workspaceId: 'project-one', label: 'Project USB devices',
  filters: [{ vendorId: 0x10c4, productId: 0xea60 }],
  operations: ['observe', 'serial.verify', 'esp32.identity', 'esp32.flash'],
};

describe('USB device profile registry', () => {
  it('returns no profiles without configuration and loads a valid profile', () => {
    expect(loadUsbDeviceProfiles('')).toEqual([]);
    expect(loadUsbDeviceProfiles(writeProfiles([profile]))).toEqual([profile]);
  });

  it('rejects duplicate workspace profiles, filters, and operations', () => {
    expect(() => loadUsbDeviceProfiles(writeProfiles([profile, { ...profile, id: 'other' }]))).toThrow('must be unique');
    expect(() => loadUsbDeviceProfiles(writeProfiles([{ ...profile, filters: [profile.filters[0], profile.filters[0]] }]))).toThrow('filters must be unique');
    expect(() => loadUsbDeviceProfiles(writeProfiles([{ ...profile, operations: ['observe', 'observe'] }]))).toThrow('operations must be unique');
  });

  it('rejects unknown operations, invalid identifiers, and oversized files', () => {
    expect(() => loadUsbDeviceProfiles(writeProfiles([{ ...profile, operations: ['usb.write'] }]))).toThrow('operations are invalid');
    expect(() => loadUsbDeviceProfiles(writeProfiles([{ ...profile, filters: [{ vendorId: 70000, productId: 1 }] }]))).toThrow('identifier is invalid');
    const directory = mkdtempSync(join(tmpdir(), 'roadex-usb-profiles-'));
    const path = join(directory, 'oversized.json');
    writeFileSync(path, 'x'.repeat(65_537));
    expect(() => loadUsbDeviceProfiles(path)).toThrow('invalid or oversized');
  });
});

function writeProfiles(profiles: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'roadex-usb-profiles-'));
  const path = join(directory, 'profiles.json');
  writeFileSync(path, JSON.stringify(profiles));
  return path;
}
