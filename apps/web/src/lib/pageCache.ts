import { registerCacheResetter } from './cacheReset'
import { pruneExpiredMapEntries, setBoundedMapEntry } from './cacheBudget'

const memoryCache = new Map<string, { expiresAt: number; value: unknown }>()
const MAX_MEMORY_CACHE_ENTRIES = 48

export function readPageCache<T>(key: string): T | null {
  const now = Date.now()
  pruneExpiredMapEntries(memoryCache, now)
  const memoryHit = memoryCache.get(key)
  if (memoryHit) {
    if (memoryHit.expiresAt > now) return memoryHit.value as T
    memoryCache.delete(key)
  }

  return null
}

export function writePageCache<T>(key: string, value: T, ttlMs = 45_000) {
  const entry = {
    value,
    expiresAt: Date.now() + ttlMs,
  }

  setBoundedMapEntry(memoryCache, key, entry, MAX_MEMORY_CACHE_ENTRIES)
}

export function clearPageCache(key: string) {
  memoryCache.delete(key)
}

export function clearAllPageCaches() {
  memoryCache.clear()
}

registerCacheResetter(clearAllPageCaches)
