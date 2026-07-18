export type DeviceBridgePolicy = {
  state: 'disabled';
  approvedFoundation: true;
  operations: ['esp32.flash'];
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
  label: string;
  byteLength: number;
  mediaType: 'application/octet-stream';
  sha256: string;
  createdAt: string;
};

export type DeviceBridgeApprovalRecord = {
  id: string;
  userId: string;
  sessionId: string;
  projectId: string;
  artifactId: string;
  artifactSha256: string;
  expectedDeviceId: string;
  operation: 'esp32.flash';
  status: 'pending' | 'consumed' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
};

export type DeviceBridgeOperationRecord = {
  id: string;
  approvalId: string;
  userId: string;
  sessionId: string;
  projectId: string;
  artifactId: string;
  artifactSha256: string;
  expectedDeviceId: string;
  operation: 'esp32.flash';
  phase: 'probe' | 'confirmation' | 'destructive' | 'reporting' | 'completed' | 'failed' | 'cancelled';
  credentialDigest: string;
  actualDeviceId?: string;
  verifiedArtifactSha256?: string;
  confirmationChallengeDigest?: string;
  destructiveNonceDigest?: string;
  nextEventSequence: number;
  phaseExpiresAt: string;
  reportingExpiresAt: string;
  createdAt: string;
  updatedAt: string;
};
