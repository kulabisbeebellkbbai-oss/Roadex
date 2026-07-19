export type SerialVerificationStage = {
  marker: string;
  pendingLabel: string;
};

export type SerialVerificationProfile = {
  id: string;
  workspaceId: string;
  label: string;
  baudRate: number;
  bufferSize: number;
  timeoutMs: number;
  requiredMarkers: string[];
  successMessage: string;
  stages: SerialVerificationStage[];
};
