export type ExpiringEntry = {
  expiresAt: number
}

export function pruneExpiredMapEntries<T extends ExpiringEntry>(map: Map<string, T>, now = Date.now()) {
  for (const [key, entry] of map.entries()) {
    if (entry.expiresAt <= now) {
      map.delete(key)
    }
  }
}

export function setBoundedMapEntry<T extends ExpiringEntry>(
  map: Map<string, T>,
  key: string,
  entry: T,
  maxEntries: number,
) {
  pruneExpiredMapEntries(map)

  if (map.has(key)) {
    map.delete(key)
  }

  map.set(key, entry)

  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value
    if (!oldestKey) break
    map.delete(oldestKey)
  }
}

export function rememberRecentValue(set: Set<string>, value: string, maxEntries: number) {
  if (!value) return

  if (set.has(value)) {
    set.delete(value)
  }

  set.add(value)

  while (set.size > maxEntries) {
    const oldestValue = set.values().next().value
    if (!oldestValue) break
    set.delete(oldestValue)
  }
}
