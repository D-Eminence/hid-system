import React, { Component, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { AppInstallPrompt } from './components/AppInstallPrompt'
import { HIDLogo } from './components/HIDLogo'
import { RouteObservability } from './components/RouteObservability'
import { RouteSeo } from './components/RouteSeo'
import { ToastProvider } from './components/toast'
import { captureException } from './lib/observabilityBridge'
import {
  AdminDashboardPage,
  AdminAiProcessingPage,
  AdminBillingPage,
  AdminLoginPage,
  DoctorAccessPage,
  DoctorAuthPage,
  DoctorDashboardPage,
  DoctorEmergencyPage,
  DoctorHistoryPage,
  DoctorPatientRecordsPage,
  LandingPage,
  MigratePage,
  CommercialProductsPage,
  EhrConfiguratorPage,
  PricingPage,
  PatientAuthPage,
  getRoutePreloadKeys,
  PatientBioDataPage,
  PatientHistoryPage,
  PatientNotificationsPage,
  PatientProfilePage,
  PatientRecordsPage,
  preloadRoutesWhenIdle,
} from './lib/routePreload'
import {
  ADMIN_LOGIN_PATH,
  ADMIN_AI_PROCESSING_PATH,
  ADMIN_BILLING_PATH,
  ADMIN_OVERVIEW_PATH,
  ADMIN_ROOT_PATH,
} from './lib/adminRoutes'
import { hasStoredIdentityAuthSession } from './lib/identityApiConfig'
import {
  HOSPITAL_ACCESS_PATH,
  HOSPITAL_AUTH_PATH,
  HOSPITAL_DASHBOARD_PATH,
  HOSPITAL_EMERGENCY_PATH,
  HOSPITAL_HISTORY_PATH,
  HOSPITAL_ROOT_PATH,
} from './lib/hospitalRoutes'
import { MIGRATE_DASHBOARD_PATH, MIGRATE_ROOT_PATH } from './lib/migrateRoutes'

class ErrorBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    captureException(error, {
      componentStack: errorInfo.componentStack,
    })
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, background: '#f3f4f6' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 40, maxWidth: 520, width: '100%', border: '1px solid #e5e7eb', textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>!</div>
            <h2 style={{ fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Something went wrong</h2>
            <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 20, lineHeight: 1.6 }}>Something went wrong. Please refresh or try again.</p>
            <button
              onClick={() => window.location.reload()}
              style={{ background: '#1a6fd4', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}
            >
              Reload Page
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

function RouteLoadingScreen() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(180deg, #f8fbff 0%, #f2f6fb 100%)', padding: 24 }}>
      <div style={{ display: 'grid', justifyItems: 'center', gap: 14, padding: '28px 24px', borderRadius: 28, background: '#fff', border: '1px solid #e5e7eb', color: '#4b5563', fontSize: 14, fontWeight: 600, boxShadow: '0 18px 38px rgba(15, 23, 42, 0.06)' }}>
        <HIDLogo size="sm" />
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #dbe3ef', borderTopColor: '#1a6fd4', display: 'inline-block', animation: 'hid-spin 0.8s linear infinite' }} />
          Loading your page...
        </div>
      </div>
      <style>{'@keyframes hid-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
    </div>
  )
}

function LegacyDoctorPatientRecordsRedirect() {
  const { hidCode = '' } = useParams()
  return <Navigate to={`/hospital/patient-records/${hidCode}`} replace />
}

function LegacyDoctorHistoryRedirect() {
  return <Navigate to={HOSPITAL_HISTORY_PATH} replace />
}

function LegacyDoctorEmergencyRedirect() {
  return <Navigate to={HOSPITAL_EMERGENCY_PATH} replace />
}

function RouteWarmup() {
  const location = useLocation()

  React.useEffect(() => {
    return preloadRoutesWhenIdle(getRoutePreloadKeys(location.pathname), 900)
  }, [location.pathname])

  return null
}

type SessionBootstrapComponent = typeof import('./components/SessionBootstrap')['SessionBootstrap']

function requiresImmediateSessionBootstrap(pathname: string) {
  return (
    pathname.startsWith('/patient/profile') ||
    pathname.startsWith('/patient/records') ||
    pathname.startsWith('/patient/history') ||
    pathname.startsWith('/patient/biodata') ||
    pathname.startsWith('/patient/notifications') ||
    pathname.startsWith('/hospital/dashboard') ||
    pathname.startsWith('/hospital/access') ||
    pathname.startsWith('/hospital/history') ||
    pathname.startsWith('/hospital/emergency') ||
    pathname.startsWith('/hospital/patient-records/') ||
    pathname.startsWith('/migrate') ||
    pathname.startsWith('/eminence/')
  )
}

function scheduleBootstrapLoad(task: () => void) {
  if (typeof window === 'undefined') return () => undefined

  const idleWindow = window as Window & {
    cancelIdleCallback?: (id: number) => void
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  }

  if (typeof idleWindow.requestIdleCallback === 'function') {
    const idleId = idleWindow.requestIdleCallback(task, { timeout: 1500 })
    return () => idleWindow.cancelIdleCallback?.(idleId)
  }

  const timer = window.setTimeout(task, 250)
  return () => window.clearTimeout(timer)
}

function DeferredSessionBootstrap() {
  const location = useLocation()
  const [Bootstrap, setBootstrap] = React.useState<SessionBootstrapComponent | null>(null)

  React.useEffect(() => {
    if (Bootstrap) return

    let active = true

    const load = () => {
      void import('./components/SessionBootstrap')
        .then(module => {
          if (active) {
            setBootstrap(() => module.SessionBootstrap)
          }
        })
        .catch(() => undefined)
    }

    const shouldLoadImmediately =
      requiresImmediateSessionBootstrap(location.pathname) ||
      hasStoredIdentityAuthSession()

    const cancel = shouldLoadImmediately ? (() => {
      load()
      return () => undefined
    })() : scheduleBootstrapLoad(load)

    return () => {
      active = false
      cancel()
    }
  }, [Bootstrap, location.pathname])

  return Bootstrap ? <Bootstrap /> : null
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider />
        <DeferredSessionBootstrap />
        <RouteObservability />
        <RouteSeo />
        <RouteWarmup />
        <AppInstallPrompt />
        <Suspense fallback={<RouteLoadingScreen />}>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/products" element={<CommercialProductsPage />} />
            <Route path="/products/:slug" element={<CommercialProductsPage />} />
            <Route path="/solutions" element={<CommercialProductsPage />} />
            <Route path="/developers" element={<CommercialProductsPage />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/configure-ehr" element={<EhrConfiguratorPage />} />
            <Route path="/signup" element={<Navigate to="/patient" replace />} />
            <Route path="/login" element={<Navigate to="/patient" replace />} />
            <Route path="/dashboard" element={<Navigate to={HOSPITAL_DASHBOARD_PATH} replace />} />
            <Route path="/register" element={<Navigate to="/patient" replace />} />
            <Route path="/doctor" element={<Navigate to={HOSPITAL_DASHBOARD_PATH} replace />} />
            <Route path="/records" element={<Navigate to="/patient/records" replace />} />
            <Route path="/logs" element={<Navigate to="/patient/history" replace />} />
            <Route path="/patient" element={<PatientAuthPage />} />
            <Route path="/patient/profile" element={<PatientProfilePage />} />
            <Route path="/patient/biodata" element={<PatientBioDataPage />} />
            <Route path="/patient/records" element={<PatientRecordsPage />} />
            <Route path="/patient/history" element={<PatientHistoryPage />} />
            <Route path="/patient/notifications" element={<PatientNotificationsPage />} />
            <Route path={ADMIN_ROOT_PATH} element={<Navigate to={ADMIN_LOGIN_PATH} replace />} />
            <Route path={ADMIN_LOGIN_PATH} element={<AdminLoginPage />} />
            <Route path={ADMIN_OVERVIEW_PATH} element={<AdminDashboardPage />} />
            <Route path={ADMIN_AI_PROCESSING_PATH} element={<AdminAiProcessingPage />} />
            <Route path={ADMIN_BILLING_PATH} element={<AdminBillingPage />} />
            <Route path={HOSPITAL_ROOT_PATH} element={<Navigate to={HOSPITAL_AUTH_PATH} replace />} />
            <Route path={HOSPITAL_AUTH_PATH} element={<DoctorAuthPage />} />
            <Route path={HOSPITAL_DASHBOARD_PATH} element={<DoctorDashboardPage />} />
            <Route path={HOSPITAL_ACCESS_PATH} element={<DoctorAccessPage />} />
            <Route path={HOSPITAL_HISTORY_PATH} element={<DoctorHistoryPage />} />
            <Route path={HOSPITAL_EMERGENCY_PATH} element={<DoctorEmergencyPage />} />
            <Route path="/hospital/patient-records/:hidCode" element={<DoctorPatientRecordsPage />} />
            <Route path={MIGRATE_ROOT_PATH} element={<Navigate to={MIGRATE_DASHBOARD_PATH} replace />} />
            <Route path="/migrate/*" element={<MigratePage />} />
            <Route path="/patient/auth" element={<Navigate to="/patient" replace />} />
            <Route path="/doctor/auth" element={<Navigate to={HOSPITAL_AUTH_PATH} replace />} />
            <Route path="/doctor/access" element={<Navigate to={HOSPITAL_ACCESS_PATH} replace />} />
            <Route path="/doctor/history" element={<LegacyDoctorHistoryRedirect />} />
            <Route path="/doctor/emergency" element={<LegacyDoctorEmergencyRedirect />} />
            <Route path="/doctor/patient-records/:hidCode" element={<LegacyDoctorPatientRecordsRedirect />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
