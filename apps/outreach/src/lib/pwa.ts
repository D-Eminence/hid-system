export async function registerOutreachServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || import.meta.env.DEV) return
  try {
    const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`, {
      scope: import.meta.env.BASE_URL,
      updateViaCache: 'none',
    })
    await registration.update().catch(() => undefined)
  } catch {
    // Offline support is best effort; registration must not affect clinical workflows.
  }
}
