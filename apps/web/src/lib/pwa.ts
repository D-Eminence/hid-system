export async function registerAppServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  if (import.meta.env.DEV) return

  try {
    const existingRegistration = await navigator.serviceWorker.getRegistration('/')
    const registration = existingRegistration ?? await navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    })

    await registration.update().catch(() => undefined)
  } catch {
    // Service worker registration is best effort only.
  }
}

export async function showBrowserNotification(title: string, options: NotificationOptions = {}) {
  if (typeof window === 'undefined' || !('Notification' in window)) return

  if (Notification.permission !== 'granted') {
    return
  }

  try {
    const registration = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration('/')
      : null

    if (registration?.showNotification) {
      await registration.showNotification(title, {
        badge: '/android-chrome-192x192.png',
        icon: '/android-chrome-192x192.png',
        ...options,
      })
      return
    }

    new Notification(title, {
      icon: '/android-chrome-192x192.png',
      ...options,
    })
  } catch {
    // Browser notifications are best effort only.
  }
}

export async function requestBrowserNotificationPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission !== 'default') return

  try {
    await Notification.requestPermission()
  } catch {
    // Permission prompts are browser-controlled and may be rejected silently.
  }
}
