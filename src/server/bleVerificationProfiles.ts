import type { BleExpectedValue, BleVerificationProfile } from '../shared/bleVerificationContracts.js';

const idPattern = /^[A-Za-z0-9._-]{1,128}$/;
const fieldPattern = /^[A-Za-z0-9._-]{1,64}$/;
const uuidPattern = /^(?:[0-9a-fA-F]{4}|[0-9a-fA-F]{8}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const printablePattern = /^[\x20-\x7e]+$/;
export function validateBleVerificationProfile(value: unknown, index: number): BleVerificationProfile {
  if (!isRecord(value)) throw new Error(`BLE verification profile ${index} must be an object.`);
  const allowed = new Set(['id', 'workspaceId', 'label', 'serviceUuid', 'characteristicUuid', 'timeoutMs', 'expectedFields', 'successMessage']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`BLE verification profile ${index} has unknown fields.`);
  if (!isRecord(value.expectedFields)) throw new Error(`BLE verification profile ${index} expectedFields is invalid.`);
  const entries = Object.entries(value.expectedFields);
  if (entries.length === 0 || entries.length > 16) throw new Error(`BLE verification profile ${index} expectedFields is invalid.`);
  const expectedFields: Record<string, BleExpectedValue> = {};
  for (const [key, fieldValue] of entries) {
    if (!fieldPattern.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key) || !isExpectedValue(fieldValue)) {
      throw new Error(`BLE verification profile ${index} expectedFields is invalid.`);
    }
    expectedFields[key] = fieldValue;
  }
  return {
    id: boundedId(value.id, 'profile id'),
    workspaceId: boundedId(value.workspaceId, 'workspace id'),
    label: boundedText(value.label, 'profile label', 80),
    serviceUuid: boundedUuid(value.serviceUuid, 'serviceUuid'),
    characteristicUuid: boundedUuid(value.characteristicUuid, 'characteristicUuid'),
    timeoutMs: boundedInteger(value.timeoutMs, 'timeoutMs', 1_000, 60_000),
    expectedFields,
    successMessage: boundedText(value.successMessage, 'successMessage', 200),
  };
}

function isExpectedValue(value: unknown): value is BleExpectedValue {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= 128 && printablePattern.test(value));
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function boundedUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error(`${field} is invalid.`);
  return value.toLowerCase();
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !printablePattern.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${field} is invalid.`);
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
