export type DeviceBridgePolicy = {
  state: 'disabled';
  approvedFoundation: true;
  operations: ['esp32.flash'];
  requestIntakeEnabled: boolean;
  descriptorObservationEnabled: boolean;
  operationsEnabled: false;
  reason: string;
};

export type BrowserDeviceCapability = {
  transport: 'webusb' | 'unavailable';
  identityProbeAvailable: boolean;
  deviceAccessRequested: false;
};

export type DeviceInventoryBindingRef = {
  id: string;
  projectId: string;
  identityVerificationAvailable: boolean;
};

export type DeviceDescriptorObservationRecord = {
  id: string;
  userId: string;
  sessionId: string;
  projectId: string;
  inventoryBindingId: string;
  vendorId: number;
  productId: number;
  descriptorFingerprint: string;
  status: 'observed';
  verification: 'unverified' | 'verified' | 'mismatch';
  createdAt: string;
};

export type DeviceDescriptorObservationPublic = Omit<
  DeviceDescriptorObservationRecord,
  'userId' | 'descriptorFingerprint'
>;

export type DeviceDescriptorObservationPayload = {
  inventoryBindingId: string;
  vendorId: number;
  productId: number;
  serialNumber?: string;
  deviceMac?: string;
};

export type DeviceDescriptorObservationResponse =
  | { ok: true; observation: DeviceDescriptorObservationPublic }
  | {
      ok: false;
      gate: 'device-bridge';
      reason: string;
      classification?: 'auth' | 'audit' | 'device-bridge' | 'session' | 'inventory' | 'schema' | 'quota';
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
  deviceMacTag?: string;
  allowedOperation: 'esp32.flash';
  secureBootExpected: 'required' | 'not-required' | 'unknown';
  flashEncryptionExpected: 'required' | 'not-required' | 'unknown';
  lifecycle: 'active' | 'revoked';
  createdBy: string;
  createdAt: string;
  revokedAt?: string;
};

export type DeviceInventoryBindingPublic = Omit<DeviceInventoryBindingRecord, 'deviceMacTag'>;

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
      binding: DeviceInventoryBindingPublic;
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
  phase: 'probe' | 'verified' | 'confirmation' | 'destructive' | 'reporting' | 'completed' | 'failed' | 'cancelled';
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

export type DeviceBridgeOperationPublic = Omit<
  DeviceBridgeOperationRecord,
  | 'userId'
  | 'deviceIdentityTag'
  | 'credentialDigest'
  | 'actualDeviceIdentityTag'
  | 'confirmationChallengeDigest'
  | 'destructiveNonceDigest'
>;

export type DeviceBridgeProbePayload = {
  deviceMac: string;
  artifactSha256: string;
};

export type DeviceBridgeProbeStartResponse =
  | { ok: true; operation: DeviceBridgeOperationPublic }
  | { ok: false; gate: 'device-bridge'; reason: string; classification?: string };

export type DeviceBridgeProbeResponse =
  | { ok: true; operation: DeviceBridgeOperationPublic }
  | { ok: false; gate: 'device-bridge'; reason: string; classification?: string };

export type DeviceBridgeConfirmationResponse = DeviceBridgeProbeResponse;
