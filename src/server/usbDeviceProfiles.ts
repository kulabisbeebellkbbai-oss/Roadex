import type { UsbDeviceOperation, UsbDeviceProfile } from '../shared/usbDeviceProfileContracts.js';

const idPattern = /^[A-Za-z0-9._-]{1,128}$/;
const printablePattern = /^[\x20-\x7e]+$/;
const allowedOperations = new Set<UsbDeviceOperation>(['observe', 'serial.verify', 'esp32.identity', 'esp32.flash']);
export function validateUsbDeviceProfile(value: unknown, index: number): UsbDeviceProfile {
  if (!isRecord(value)) throw new Error(`USB device profile ${index} must be an object.`);
  const allowed = new Set(['id', 'workspaceId', 'label', 'filters', 'operations']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`USB device profile ${index} has unknown fields.`);
  if (!Array.isArray(value.filters) || value.filters.length === 0 || value.filters.length > 16) throw new Error(`USB device profile ${index} filters are invalid.`);
  const filters = value.filters.map((filter) => {
    if (!isRecord(filter) || Object.keys(filter).some((key) => key !== 'vendorId' && key !== 'productId')) throw new Error(`USB device profile ${index} filters are invalid.`);
    return { vendorId: usbId(filter.vendorId), productId: usbId(filter.productId) };
  });
  if (new Set(filters.map((filter) => `${filter.vendorId}:${filter.productId}`)).size !== filters.length) throw new Error(`USB device profile ${index} filters must be unique.`);
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > allowedOperations.size ||
      value.operations.some((operation) => typeof operation !== 'string' || !allowedOperations.has(operation as UsbDeviceOperation))) {
    throw new Error(`USB device profile ${index} operations are invalid.`);
  }
  const operations = value.operations as UsbDeviceOperation[];
  if (new Set(operations).size !== operations.length) throw new Error(`USB device profile ${index} operations must be unique.`);
  return {
    id: boundedId(value.id, 'profile id'), workspaceId: boundedId(value.workspaceId, 'workspace id'),
    label: boundedText(value.label, 'profile label', 80), filters, operations,
  };
}

function usbId(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 65_535) throw new Error('USB device identifier is invalid.');
  return value as number;
}
function boundedId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}
function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !printablePattern.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
