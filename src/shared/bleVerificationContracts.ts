export type BleExpectedValue = string | number | boolean;

export type BleVerificationProfile = {
  id: string;
  workspaceId: string;
  label: string;
  serviceUuid: string;
  characteristicUuid: string;
  timeoutMs: number;
  expectedFields: Record<string, BleExpectedValue>;
  successMessage: string;
};
