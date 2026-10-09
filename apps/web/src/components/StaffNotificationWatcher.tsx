import React, { useEffect } from 'react'
import { showToast } from './toast'
import { rememberRecentValue } from '../lib/cacheBudget'
import { listCurrentUserNotifications } from '../lib/hidApi'
import { subscribeToNotifications } from '../lib/notificationsRealtime'

const surfacedStaffNotificationIds = new Set<string>()
const MAX_TRACKED_NOTIFICATION_IDS = 200

export function StaffNotificationWatcher({ onAccessRevoked }: { onAccessRevoked?: () => void }) {
  useEffect(() => {
    let cancelled = false

    async function flushUnreadSummary() {
      const unread = await listCurrentUserNotifications(10, { unreadOnly: true, forceRefresh: true })
      if (cancelled) return

      const unseen = unread.filter(item => !surfacedStaffNotificationIds.has(item.id))
      if (unseen.length === 0) return

      let revokedHandled = false
      unseen
        .slice()
        .reverse()
        .forEach(item => {
          const combined = `${item.title} ${item.message}`.toLowerCase()
          const isRevoked = combined.includes('access revoked') || combined.includes('revoked')
          showToast(`${item.title}: ${item.message}`, isRevoked ? 'error' : 'info')
          if (isRevoked && !revokedHandled) {
            revokedHandled = true
            onAccessRevoked?.()
          }
        })
      unseen.forEach(item => {
        rememberRecentValue(surfacedStaffNotificationIds, item.id, MAX_TRACKED_NOTIFICATION_IDS)
      })
    }

    void flushUnreadSummary()
    const unsubscribe = subscribeToNotifications(() => {
      if (document.visibilityState === 'visible') {
        void flushUnreadSummary()
      }
    })
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void flushUnreadSummary()
      }
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void flushUnreadSummary()
      }
    }, 45000)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      cancelled = true
      unsubscribe()
      document.removeEventListener('visibilitychange', handleVisibility)
      window.clearInterval(interval)
    }
  }, [onAccessRevoked])

  return null
}
