import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadProjectDeviceManifest } from '../src/server/projectDeviceManifest';

const usb = {
  id: 'project-usb', label: 'Project USB',
  filters: [{ vendorId: 0x10c4, productId: 0xea60 }],
  operations: ['observe', 'serial.verify'],
};
const serial = {
  id: 'project-serial', label: 'Project serial', baudRate: 115200, bufferSize: 8192,
  timeoutMs: 15000, requiredMarkers: ['runtime ready'], successMessage: 'Runtime verified.', stages: [],
};
const ble = {
  id: 'project-ble', label: 'Project BLE', serviceUuid: '180f', characteristicUuid: '2a19',
  timeoutMs: 15000, expectedFields: { ready: true }, successMessage: 'BLE verified.',
};

describe('project device manifest', () => {
  it('returns empty registries without configuration', () => {
    expect(loadProjectDeviceManifest('')).toEqual({
      serialVerificationProfiles: [], bleVerificationProfiles: [], usbDeviceProfiles: [],
    });
  });

  it('loads one project configuration into the stable profile registries', () => {
    expect(loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', usb, serial, ble }],
    }))).toEqual({
      usbDeviceProfiles: [{ ...usb, workspaceId: 'project-one' }],
      serialVerificationProfiles: [{ ...serial, workspaceId: 'project-one' }],
      bleVerificationProfiles: [{ ...ble, workspaceId: 'project-one' }],
    });
  });

  it('rejects unsupported versions, unknown fields, and duplicate workspaces atomically', () => {
    expect(() => loadProjectDeviceManifest(writeManifest({ version: 2, projects: [] }))).toThrow('version is unsupported');
    expect(() => loadProjectDeviceManifest(writeManifest({ version: 1, projects: [], extra: true }))).toThrow('unknown fields');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1,
      projects: [
        { workspaceId: 'project-one', usb },
        { workspaceId: 'project-one', ble },
      ],
    }))).toThrow('workspace IDs must be unique');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1,
      projects: [
        { workspaceId: 'project-one', usb },
        { workspaceId: 'project-two', usb },
      ],
    }))).toThrow('USB profile IDs must be unique');
  });

  it('rejects nested unknown fields and embedded workspace IDs', () => {
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', usb: { ...usb, extra: true } }],
    }))).toThrow('unknown fields');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', usb: { ...usb, workspaceId: 'other' } }],
    }))).toThrow('USB section is invalid');
  });

  it('requires a USB serial capability when serial verification is configured', () => {
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', serial }],
    }))).toThrow('requires an allowed USB serial.verify operation');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', usb: { ...usb, operations: ['observe'] }, serial }],
    }))).toThrow('requires an allowed USB serial.verify operation');
  });

  it('rejects unsafe serial values through the unified boundary', () => {
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', usb, serial: { ...serial, successMessage: 'bad\nmessage' } }],
    }))).toThrow('successMessage is invalid');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', usb, serial: { ...serial, bufferSize: 1 } }],
    }))).toThrow('bufferSize is invalid');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', usb, serial: { ...serial, requiredMarkers: Array(17).fill('marker') } }],
    }))).toThrow('bounded array');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{
        workspaceId: 'project-one', usb,
        serial: { ...serial, stages: [{ marker: 'runtime ready', pendingLabel: 'duplicate' }] },
      }],
    }))).toThrow('markers must be unique');
  });

  it('rejects unsafe BLE fields through the unified boundary', () => {
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', ble: { ...ble, serviceUuid: 'not-a-uuid' } }],
    }))).toThrow('serviceUuid is invalid');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', ble: { ...ble, timeoutMs: 1 } }],
    }))).toThrow('timeoutMs is invalid');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', ble: { ...ble, expectedFields: {} } }],
    }))).toThrow('expectedFields is invalid');
    expect(() => loadProjectDeviceManifest(writeRaw(
      '{"version":1,"projects":[{"workspaceId":"project-one","ble":{"id":"ble","label":"BLE","serviceUuid":"180f","characteristicUuid":"2a19","timeoutMs":1000,"expectedFields":{"__proto__":true},"successMessage":"Verified"}}]}',
    ))).toThrow('expectedFields is invalid');
  });

  it('rejects unsafe USB filters and operations through the unified boundary', () => {
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', usb: { ...usb, filters: [usb.filters[0], usb.filters[0]] } }],
    }))).toThrow('filters must be unique');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', usb: { ...usb, operations: ['observe', 'observe'] } }],
    }))).toThrow('operations must be unique');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', usb: { ...usb, operations: ['usb.write'] } }],
    }))).toThrow('operations are invalid');
    expect(() => loadProjectDeviceManifest(writeManifest({
      version: 1, projects: [{ workspaceId: 'project-one', usb: { ...usb, filters: [{ vendorId: 70000, productId: 1 }] } }],
    }))).toThrow('identifier is invalid');
  });

  it('rejects an oversized file before parsing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'roadex-device-manifest-'));
    const path = join(directory, 'manifest.json');
    writeFileSync(path, 'x'.repeat(65_537));
    chmodSync(path, 0o600);
    expect(() => loadProjectDeviceManifest(path)).toThrow('invalid, insecure, or oversized');
  });

  it('rejects duplicate keys at any nesting level', () => {
    expect(() => loadProjectDeviceManifest(writeRaw('{"version":1,"version":1,"projects":[]}'))).toThrow('duplicate key');
    expect(() => loadProjectDeviceManifest(writeRaw(
      '{"version":1,"projects":[{"workspaceId":"project-one","usb":{"id":"one","id":"two","label":"USB","filters":[],"operations":[]}}]}',
    ))).toThrow('duplicate key');
  });

  it('rejects symlinks and group-writable manifests', () => {
    const target = writeManifest({ version: 1, projects: [] });
    const directory = mkdtempSync(join(tmpdir(), 'roadex-device-manifest-link-'));
    const link = join(directory, 'manifest.json');
    symlinkSync(target, link);
    expect(() => loadProjectDeviceManifest(link)).toThrow('invalid, insecure, or unavailable');

    chmodSync(target, 0o664);
    expect(() => loadProjectDeviceManifest(target)).toThrow('invalid, insecure, or oversized');
  });

  it('rejects legacy profile variables instead of accepting two policy sources', () => {
    const previous = process.env.ROADEX_USB_DEVICE_PROFILES_FILE;
    process.env.ROADEX_USB_DEVICE_PROFILES_FILE = '/unused/legacy.json';
    try {
      expect(() => loadProjectDeviceManifest('')).toThrow('Legacy device profile environment variables');
    } finally {
      if (previous === undefined) delete process.env.ROADEX_USB_DEVICE_PROFILES_FILE;
      else process.env.ROADEX_USB_DEVICE_PROFILES_FILE = previous;
    }
  });
});

function writeManifest(manifest: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'roadex-device-manifest-'));
  const path = join(directory, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest));
  chmodSync(path, 0o600);
  return path;
}

function writeRaw(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'roadex-device-manifest-'));
  const path = join(directory, 'manifest.json');
  writeFileSync(path, source);
  chmodSync(path, 0o600);
  return path;
}
