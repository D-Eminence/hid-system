import React, { useEffect } from 'react'
import { showToast } from './toast'
import { rememberRecentValue } from '../lib/cacheBudget'
import { listUnreadNotifications } from '../lib/hidApi'
import { subscribeToNotifications } from '../lib/notificationsRealtime'
import { requestBrowserNotificationPermission, showBrowserNotification } from '../lib/pwa'

const TOAST_PREVIEW_LIMIT = 3
const MAX_TRACKED_NOTIFICATION_IDS = 200
const surfacedPatientNotificationIds = new Set<string>()

export function PatientNotificationWatcher({ hidCode }: { hidCode: string }) {
  useEffect(() => {
    let cancelled = false

    async function flushUnreadSummary() {
      const unread = await listUnreadNotifications(hidCode, TOAST_PREVIEW_LIMIT + 1, { forceRefresh: true })
      const unseen = unread.filter(item => !surfacedPatientNotificationIds.has(item.id))
      if (cancelled || unseen.length === 0) return

      if (unseen.length <= TOAST_PREVIEW_LIMIT) {
        unseen.slice().reverse().forEach(item => {
          showToast(`${item.title}: ${item.message}`, item.message.toLowerCase().includes('emergency') ? 'error' : 'info')
          void showBrowserNotification(item.title, {
            body: item.message,
            tag: `hid-notification-${item.id}`,
          })
        })
      } else {
        const emergencyItem = unseen.find(item => `${item.title} ${item.message}`.toLowerCase().includes('emergency'))
        if (emergencyItem) {
          showToast(`${emergencyItem.title}: ${emergencyItem.message}`, 'error')
          void showBrowserNotification(emergencyItem.title, {
            body: emergencyItem.message,
            tag: `hid-notification-${emergencyItem.id}`,
          })
        }
        showToast(`You have ${unseen.length} new notifications. Open Notifications to review them.`, 'info')
        void showBrowserNotification('New HID notifications', {
          body: `You have ${unseen.length} new notifications.`,
          tag: 'hid-notifications-summary',
        })
      }

      unseen.forEach(item => {
        rememberRecentValue(surfacedPatientNotificationIds, item.id, MAX_TRACKED_NOTIFICATION_IDS)
      })
    }

    void requestBrowserNotificationPermission()
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
  }, [hidCode])

  return null
}
