import React, { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { updateObservabilityForRoute } from '../lib/observabilityBridge'

export function RouteObservability() {
  const location = useLocation()

  useEffect(() => {
    updateObservabilityForRoute(location.pathname)
  }, [location.pathname])

  return null
}
