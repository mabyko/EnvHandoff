// Versioned beta operating limits. Adjust with deployment and quota regression checks.
// File-format limits, cryptographic parameters and security lifetimes live with their protocols.
export const limits = {
  organizationMembers: 20,
  userDevices: 5,
  organizationStorageBytes: 512 * 1024 * 1024,
  concurrentUploads: 3,
  pendingRequests: 100,
  creationAttempts: 20,
  creationWindowMs: 10 * 60_000,
  organizationDailyDownloadBytes: 1024 * 1024 * 1024,
  concurrentDownloads: 3,
  shareRequestsPerMinute: 30,
  ipRequestsPerMinute: 60,
} as const
