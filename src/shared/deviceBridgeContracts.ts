export type DeviceBridgePolicy = {
  state: 'disabled';
  approvedFoundation: true;
  operations: ['esp32.flash'];
  requestIntakeEnabled: boolean;
  operationsEnabled: false;
  reason: string;
};

export type BrowserDeviceCapability = {
  transport: 'web-serial' | 'webusb-polyfill' | 'unavailable';
  deviceAccessRequested: false;
};

export type DeviceArtifactMetadata = {
  id: string;
  projectId: string;
  sessionId: string;
  producerUserId: string;
  producerThreadId?: string;
  producerRunId?: string;
  label: string;
  byteLength: number;
  mediaType: 'application/octet-stream';
  format: 'esp32-firmware-bin';
  sha256: string;
  storageReference: string;
  status: 'active' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
};

export type DeviceArtifactMetadataPublic = Omit<DeviceArtifactMetadata, 'storageReference'>;

export type DeviceInventoryBindingRecord = {
  id: string;
  projectId: string;
  deviceIdentityTag: string;
  allowedOperation: 'esp32.flash';
  secureBootExpected: 'required' | 'not-required' | 'unknown';
  flashEncryptionExpected: 'required' | 'not-required' | 'unknown';
  lifecycle: 'active' | 'revoked';
  createdBy: string;
  createdAt: string;
  revokedAt?: string;
};

export type DeviceArtifactMetadataRegistrationPayload = {
  artifactPath: string;
  label?: string;
};

export type DeviceInventoryBindingPayload = {
  projectId: string;
  normalizedDeviceIdentity: string;
  allowedOperation: 'esp32.flash';
  secureBootExpected: 'required' | 'not-required' | 'unknown';
  flashEncryptionExpected: 'required' | 'not-required' | 'unknown';
};

export type DeviceBridgeMetadataResponse =
  | {
      ok: true;
      artifact: DeviceArtifactMetadataPublic;
    }
  | {
      ok: false;
      gate: 'device-bridge';
      reason: string;
      classification?: 'auth' | 'audit' | 'device-bridge' | 'session' | 'workspace' | 'schema' | 'quota';
    };

export type DeviceInventoryBindingResponse =
  | {
      ok: true;
      binding: DeviceInventoryBindingRecord;
    }
  | {
      ok: false;
      gate: 'device-bridge';
      reason: string;
      classification?: 'auth' | 'audit' | 'device-bridge' | 'workspace' | 'schema' | 'quota';
    };

export type DeviceBridgeApprovalRecord = {
  id: string;
  requestId: string;
  userId: string;
  sessionId: string;
  projectId: string;
  artifactId: string;
  artifactSha256: string;
  inventoryBindingId: string;
  deviceIdentityTag: string;
  credentialDigest: string;
  operation: 'esp32.flash';
  status: 'pending' | 'consumed' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
};

export type DeviceBridgeRequestRecord = {
  id: string;
  userId: string;
  sessionId: string;
  projectId: string;
  artifactId: string;
  artifactSha256: string;
  inventoryBindingId: string;
  deviceIdentityTag: string;
  operation: 'esp32.flash';
  status: 'pending' | 'approved' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
};

export type DeviceBridgeRequestPublic = Omit<DeviceBridgeRequestRecord, 'deviceIdentityTag'>;
export type DeviceBridgeApprovalPublic = Omit<DeviceBridgeApprovalRecord, 'userId' | 'deviceIdentityTag' | 'credentialDigest'>;

export type DeviceBridgeRequestPayload = {
  workspaceId: string;
  artifactId: string;
  artifactSha256: string;
  inventoryBindingId: string;
  operation: 'esp32.flash';
};

export type DeviceBridgeRequestResponse =
  | {
      ok: true;
      request: DeviceBridgeRequestPublic;
    }
  | {
      ok: false;
      gate: 'device-bridge';
      reason: string;
      classification?: 'auth' | 'audit' | 'device-bridge' | 'session' | 'workspace' | 'artifact' | 'inventory' | 'schema' | 'quota';
    };

export type DeviceBridgeApprovalResponse =
  | {
      ok: true;
      approval: DeviceBridgeApprovalPublic;
    }
  | {
      ok: false;
      gate: 'device-bridge';
      reason: string;
      classification?: 'auth' | 'audit' | 'device-bridge' | 'request' | 'session' | 'artifact' | 'inventory';
    };

export type DeviceBridgeOperationRecord = {
  id: string;
  approvalId: string;
  userId: string;
  sessionId: string;
  projectId: string;
  artifactId: string;
  artifactSha256: string;
  inventoryBindingId: string;
  deviceIdentityTag: string;
  operation: 'esp32.flash';
  phase: 'probe' | 'confirmation' | 'destructive' | 'reporting' | 'completed' | 'failed' | 'cancelled';
  credentialDigest: string;
  actualDeviceIdentityTag?: string;
  verifiedArtifactSha256?: string;
  confirmationChallengeDigest?: string;
  destructiveNonceDigest?: string;
  nextEventSequence: number;
  phaseExpiresAt: string;
  reportingExpiresAt: string;
  createdAt: string;
  updatedAt: string;
};
