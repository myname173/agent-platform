type CacheEntry<T> = {
  expiresAt: number;
  value?: T;
  pending?: Promise<T>;
};

type ReadCacheOptions<T> = {
  ttlMs?: number;
  shouldCache?: (value: T) => boolean;
};

type ReadCacheResult<T> = {
  value: T;
  hit: boolean;
};

const DEFAULT_TTL_MS = 3000;

const cache = new Map<string, CacheEntry<unknown>>();

function ttlMs<T>(options?: ReadCacheOptions<T>) {
  const configured = Number(process.env.CONSOLE_ADMIN_READ_CACHE_TTL_MS || DEFAULT_TTL_MS);
  return options?.ttlMs ?? (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_MS);
}

export async function withAdminReadCache<T>(
  key: string,
  loader: () => Promise<T>,
  options?: ReadCacheOptions<T>
): Promise<ReadCacheResult<T>> {
  const now = Date.now();
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  if (existing?.value !== undefined && existing.expiresAt > now) {
    return { value: existing.value, hit: true };
  }
  if (existing?.pending) {
    return { value: await existing.pending, hit: true };
  }

  const pending = loader();
  cache.set(key, { expiresAt: 0, pending });
  try {
    const value = await pending;
    if (!options?.shouldCache || options.shouldCache(value)) {
      cache.set(key, { expiresAt: Date.now() + ttlMs(options), value });
    } else {
      cache.delete(key);
    }
    return { value, hit: false };
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

export function invalidateAdminReadCache(...keys: string[]) {
  for (const key of keys) {
    if (key.endsWith('*')) {
      const prefix = key.slice(0, -1);
      for (const cachedKey of cache.keys()) {
        if (cachedKey.startsWith(prefix)) cache.delete(cachedKey);
      }
    } else {
      cache.delete(key);
    }
  }
}

export function adminReadCacheHeaders(hit: boolean) {
  return {
    'X-Admin-Read-Cache': hit ? 'hit' : 'miss',
    'Cache-Control': 'private, no-store'
  };
}
