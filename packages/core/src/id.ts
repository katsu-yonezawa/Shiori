export function createId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${random}`;
}

export function getDeviceId(): string {
  const key = 'shiori.deviceId';
  const existing = globalThis.localStorage?.getItem(key);

  if (existing) {
    return existing;
  }

  const next = createId('device');
  globalThis.localStorage?.setItem(key, next);
  return next;
}

