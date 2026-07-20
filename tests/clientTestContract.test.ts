import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';

type SuiteManifest = {
  version: number;
  suites: Array<{ id: string; definition: string; description: string; cases: string[]; destructive: boolean }>;
};

type SuiteDefinition = {
  version: number;
  id: string;
  viewports: string[];
  cases: Array<{ id: string; steps: Array<Record<string, unknown>> }>;
};

const root = resolve(import.meta.dirname, '..');
const sensitiveControls = new Set([
  'create-probe-approval', 'run-controlled-probe', 'confirm-verified-target',
  'verify-firmware-bytes', 'flash-firmware',
]);

describe('MSI client test contract', () => {
  it('publishes unique repository-owned suites without executable job commands', () => {
    const manifest = readJson<SuiteManifest>('client-tests/suites.json');
    expect(manifest.version).toBe(1);
    expect(manifest.suites.length).toBeGreaterThan(0);
    expect(new Set(manifest.suites.map((suite) => suite.id)).size).toBe(manifest.suites.length);
    for (const suite of manifest.suites) {
      expect(suite.id).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      expect(suite.definition).toMatch(/^suites\/[A-Za-z0-9._-]+\.json$/);
      expect(typeof suite.destructive).toBe('boolean');
      expect(suite.cases.length).toBeGreaterThan(0);
      expect(new Set(suite.cases).size).toBe(suite.cases.length);
      for (const caseId of suite.cases) expect(caseId).toMatch(/^[A-Za-z0-9._-]{1,96}$/);
      expect(suite).not.toHaveProperty('command');
      const definition = readJson<SuiteDefinition>(`client-tests/${suite.definition}`);
      expect(definition.version).toBe(1);
      expect(definition.id).toBe(suite.id);
      expect(definition.cases.map((testCase) => testCase.id)).toEqual(suite.cases);
      for (const testCase of definition.cases) {
        const checkpointIds = testCase.steps
          .filter((step) => step.action === 'manualCheckpoint')
          .map((step) => String(step.checkpoint));
        expect(new Set(checkpointIds).size).toBe(checkpointIds.length);
        for (const step of testCase.steps) {
          expect([
            'navigate', 'assertVisible', 'click', 'selectOption', 'selectFirstOption',
            'assertEnabled', 'captureAttribute', 'assertAttributeChanged', 'assertAttributeRestored',
            'assertAttributeValue', 'manualCheckpoint', 'assertNoBrowserErrors',
          ]).toContain(step.action);
          expect(step).not.toHaveProperty('command');
          expect(step).not.toHaveProperty('script');
          expect(step).not.toHaveProperty('evaluate');
          if (!suite.destructive && step.action === 'click') {
            expect(sensitiveControls.has(String(step.testId))).toBe(false);
          }
        }
      }
    }
  });

  it('requires a pinned commit and rejects arbitrary job fields by schema', () => {
    const schema = readJson<Record<string, unknown>>('client-tests/job.schema.json');
    expect(schema.additionalProperties).toBe(false);
    expect(schema).not.toHaveProperty('properties.command');
    expect(schema).not.toHaveProperty('properties.script');
    expect(schema).not.toHaveProperty('properties.arguments');
    expect(schema.required).toEqual(expect.arrayContaining(['commit', 'suite', 'destructiveApproval']));
  });

  it('publishes a closed declarative suite schema without script execution actions', () => {
    const schema = readJson<Record<string, unknown>>('client-tests/suite.schema.json');
    const serialized = JSON.stringify(schema).toLowerCase();
    expect(schema.additionalProperties).toBe(false);
    for (const forbidden of ['shell', 'command', 'script', 'evaluate', 'powershell', 'javascript']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('publishes a closed manifest schema and job-bound result schema', () => {
    const manifestSchema = readJson<Record<string, unknown>>('client-tests/manifest.schema.json');
    const resultSchema = readJson<Record<string, unknown>>('client-tests/result.schema.json');
    expect(manifestSchema.additionalProperties).toBe(false);
    expect(resultSchema.required).toEqual(expect.arrayContaining(['jobId', 'commit', 'suite', 'aggregate', 'tests']));
    expect(JSON.stringify(resultSchema)).toContain('"total"');
  });

  it('validates current contracts with JSON Schema 2020-12', () => {
    const manifestSchema = readJson<object>('client-tests/manifest.schema.json');
    const suiteSchema = readJson<object>('client-tests/suite.schema.json');
    const jobSchema = readJson<object>('client-tests/job.schema.json');
    const resultSchema = readJson<object>('client-tests/result.schema.json');
    const manifest = readJson<SuiteManifest>('client-tests/suites.json');
    expect(compile(manifestSchema)(manifest)).toBe(true);
    const validateSuite = compile(suiteSchema);
    for (const suite of manifest.suites) {
      expect(validateSuite(readJson(`client-tests/${suite.definition}`))).toBe(true);
    }
    expect(compile(jobSchema)({
      id: 'contract-smoke', type: 'roadex.client_suite', commit: 'a'.repeat(40),
      suite: 'portal-smoke', headed: true, destructiveApproval: false,
    })).toBe(true);
    expect(compile(resultSchema)({
      schemaVersion: 1, jobId: 'contract-smoke', commit: 'a'.repeat(40), suite: 'portal-smoke', status: 'passed',
      aggregate: { passed: 1, failed: 0, timedOut: 0, skipped: 0, interrupted: 0, needsUser: 0, total: 1 },
      cleanup: { finalizedCases: 1, succeeded: 1, timedOut: 0, preTeardownRequestFailures: 0 },
      tests: [{ project: 'desktop', case: 'portal.authenticated-page', status: 'passed' }],
    })).toBe(true);
  });

  it('rejects command injection and origin-escaping navigation by schema', () => {
    const validateJob = compile(readJson<object>('client-tests/job.schema.json'));
    const validateSuite = compile(readJson<object>('client-tests/suite.schema.json'));
    expect(validateJob({
      id: 'bad-job', type: 'roadex.client_suite', commit: 'a'.repeat(40), suite: 'portal-smoke',
      headed: true, destructiveApproval: false, command: 'whoami',
    })).toBe(false);
    expect(validateSuite({
      version: 1, id: 'bad-suite', viewports: ['desktop'], cases: [{
        id: 'escape', steps: [{ action: 'navigate', path: '//outside.example', status: 200, cacheControl: 'no-store' }],
      }],
    })).toBe(false);
  });

  it('binds resumable checkpoints to one viewport and needsUser result', () => {
    const validateResult = compile(readJson<object>('client-tests/result.schema.json'));
    const base = {
      schemaVersion: 1, jobId: 'checkpoint-smoke', commit: 'a'.repeat(40), suite: 'peripheral-smoke',
      aggregate: { passed: 0, failed: 0, timedOut: 0, skipped: 0, interrupted: 0, needsUser: 1, total: 1 },
      tests: [{ project: 'desktop', case: 'device.select', status: 'needsUser' }],
    };
    expect(validateResult({
      ...base, status: 'needsUser',
      checkpoint: { project: 'desktop', case: 'device.select', checkpoint: 'choose-device', promptCode: 'selectUsbDevice' },
    })).toBe(true);
    expect(validateResult({ ...base, status: 'needsUser' })).toBe(false);
    expect(validateResult({
      ...base, status: 'passed',
      checkpoint: { project: 'desktop', case: 'device.select', checkpoint: 'choose-device', promptCode: 'selectUsbDevice' },
    })).toBe(false);
  });

  it('limits queue results to redacted aggregate fields', () => {
    const schema = readJson<Record<string, unknown>>('client-tests/result.schema.json');
    const validateResult = compile(schema);
    const serialized = JSON.stringify(schema);
    for (const forbidden of ['cookie', 'csrf', 'header', 'body', 'deviceId', 'serialNumber', 'mac', 'hmac', 'screenshot']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    const base = {
      schemaVersion: 1, jobId: 'cleanup-smoke', commit: 'a'.repeat(40), suite: 'portal-smoke', status: 'passed',
      aggregate: { passed: 1, failed: 0, timedOut: 0, skipped: 0, interrupted: 0, needsUser: 0, total: 1 },
      tests: [{ project: 'desktop', case: 'portal.authenticated-page', status: 'passed' }],
    };
    expect(validateResult({
      ...base,
      cleanup: { finalizedCases: 1, succeeded: 1, timedOut: 0, preTeardownRequestFailures: 0 },
    })).toBe(true);
    expect(validateResult({
      ...base,
      cleanup: {
        finalizedCases: 1, succeeded: 1, timedOut: 0, preTeardownRequestFailures: 0,
        requests: [{ url: 'https://roadex.home.arpa/private' }],
      },
    })).toBe(false);
  });
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as T;
}

function compile(schema: object) {
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}
