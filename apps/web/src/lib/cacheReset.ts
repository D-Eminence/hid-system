const resetters = new Set<() => void>()

export function registerCacheResetter(resetter: () => void) {
  resetters.add(resetter)
  return () => {
    resetters.delete(resetter)
  }
}

export function resetClientCaches() {
  resetters.forEach(resetter => {
    try {
      resetter()
    } catch {
      // Best effort only.
    }
  })
}
