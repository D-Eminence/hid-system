import { useCallback, useEffect, useState } from 'react'
import { sanitizeUserFacingMessage, showToast } from '../components/toast'
import { fetchAdminDashboardOverview } from '../services/adminDashboard'
import type { AdminDashboardOverview, AdminOverviewWindow } from '../types/admin'

const REFRESH_INTERVAL_MS = 60000

export function useAdminDashboard(windowKey: AdminOverviewWindow, selectedDate: string | null) {
  const [data, setData] = useState<AdminDashboardOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runRequest = useCallback(async ({
    force,
    silent,
    toastOnError,
  }: {
    force: boolean
    silent: boolean
    toastOnError: boolean
  }) => {
    if (silent) {
      setRefreshing(true)
    } else {
      setLoading(true)
      setRefreshing(true)
    }
    try {
      const next = await fetchAdminDashboardOverview(windowKey, { date: selectedDate, force })
      setData(next)
      setError(null)
      return next
    } catch (reason) {
      const rawMessage = reason instanceof Error ? reason.message : 'Unable to load the admin dashboard.'
      const lower = rawMessage.toLowerCase()
      const message =
        lower.includes('permission')
          ? 'Admin access is limited to platform admins.'
          : lower.includes('sign in') || lower.includes('401')
            ? 'Sign in to open the admin dashboard.'
            : lower.includes('sentry')
              ? 'Sentry data is not available right now.'
              : lower.includes('posthog')
                ? 'PostHog data is not available right now.'
                : sanitizeUserFacingMessage(rawMessage, 'error')
      setError(message)
      if (toastOnError) {
        showToast(message, 'error')
      }
      throw reason
    } finally {
      setRefreshing(false)
      if (!silent) setLoading(false)
    }
  }, [selectedDate, windowKey])

  const refresh = useCallback(async (silent = false) => (
    runRequest({
      force: true,
      silent,
      toastOnError: !silent,
    })
  ), [runRequest])

  useEffect(() => {
    void runRequest({
      force: false,
      silent: false,
      toastOnError: true,
    }).catch(() => undefined)
  }, [runRequest])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh(true).catch(() => undefined)
      }
    }, REFRESH_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [refresh])

  return {
    data,
    error,
    loading,
    refreshing,
    refresh,
  }
}
