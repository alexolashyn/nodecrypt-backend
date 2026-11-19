export const FILE_REGISTRY_ABI = [
  'function getFile(address owner, bytes32 fileId) view returns (tuple(bytes cid, bytes wrappedFileKey, bytes encryptedMeta, uint64 sizeBytes, uint64 uploadedAt, uint32 mkVersion, bool removed, bool exists))',
] as const;

export const STORAGE_TIER_ABI = [
  'function freeMaxFileBytes() view returns (uint64)',
  'function premiumMaxFileBytes() view returns (uint64)',
] as const;
