import React, { useEffect, useState } from 'react';
import { Icon, ToastProvider, showToast } from '@/components/ui/Primitives';
import { EMPTY_FACILITY_CONTEXT, NAV_ITEMS } from '@/config/ehr';
import { EhrLogin } from '@/components/auth/EhrLogin';
import { EhrSignup } from '@/components/auth/EhrSignup';
import { EhrForgot } from '@/components/auth/EhrForgot';
import { authApi, ApiProblemError } from '@/api/client';
import { deriveStaffRole } from '@/auth/session';
import { EncounterWorkspace } from '@/components/clinical/EncounterWorkspace';
import { PatientsModule } from '@/components/clinical/PatientsModule';
import { RegistrationModule } from '@/components/clinical/RegistrationModule';
import { RoleDashboard } from '@/components/dashboards/RoleDashboard';
import { TopBar, TopNav } from '@/components/layout/Shell';
import { ModuleDirectory, ModuleWorkspace } from '@/components/modules/ModuleDirectory';
import { SetupWizard } from './ehr-setup';

/* Active EHR root. Retained legacy workflows are exposed through the controlled module directory. */

const NEW_FACILITY_CONFIG = {
  name: '',
  code: '',
  type: '',
  departments: [],
  multiBranch: false,
  branches: [],
  currency: '',
  timezone: '',
  hmoIntegrated: false,
};

const facilityConfigFromSession = (session) => ({
  ...NEW_FACILITY_CONFIG,
  name: session.facility.name,
  code: session.facility.code || '',
  type: session.facility.type || '',
  departments: session.facility.departments?.length ? [...session.facility.departments] : [],
  branches: [{
    id: 'main',
    name: session.facility.name,
    code: session.facility.code || '',
  }],
});

const App = () => {
  const [phase, setPhase] = useState('checking'); // 'checking' | 'login' | 'signup' | 'forgot' | 'onboarding' | 'app'
  const [authError, setAuthError] = useState('');
  const [authSession, setAuthSession] = useState(null);
  const [role, setRole] = React.useState(null);
  const [facility, setFacility] = React.useState(EMPTY_FACILITY_CONTEXT);
  const [facilityConfig, setFacilityConfig] = React.useState(NEW_FACILITY_CONFIG);
  const [nav, setNav] = React.useState('patients');
  const [activeModule, setActiveModule] = React.useState(null);
  const [patientSearchHid, setPatientSearchHid] = React.useState('');
  const [patientSearchRequestId, setPatientSearchRequestId] = React.useState(0);
  const [mobileMoreOpen, setMobileMoreOpen] = React.useState(false);

  // Authorized patient workspace state
  const [selectedPatient, setSelectedPatient] = React.useState(null);
  const [cStage, setCStage] = React.useState('pick'); // 'pick' | 'consult'

  const establishSession = React.useCallback((session) => {
    try {
      authApi.setSession(session);
      const verifiedRole = deriveStaffRole(session);
      setFacility({
        ...EMPTY_FACILITY_CONTEXT,
        id: session.facility.id,
        name: session.facility.name,
        type: session.facility.type || EMPTY_FACILITY_CONTEXT.type,
        code: session.facility.code || '',
        departments: session.facility.departments || [],
      });
      setFacilityConfig(facilityConfigFromSession(session));
      setRole(verifiedRole);
      setAuthSession(session);
      setNav(verifiedRole.home || 'patients');
      setAuthError('');
      setPhase('app');
      setActiveModule(null);
    } catch (error) {
      void authApi.logout().catch(() => authApi.clear());
      setRole(null);
      setAuthSession(null);
      setAuthError(error instanceof Error ? error.message : 'The authenticated staff profile is not valid for this EHR.');
      setPhase('login');
    }
    setSelectedPatient(null);
    setCStage('pick');
  }, []);

  const handleFacilityLaunch = React.useCallback((config) => {
    const nextConfig = {
      ...config,
      name: config.name.trim(),
      code: config.code.trim().toUpperCase(),
      departments: [...config.departments],
      branches: config.branches.map(branch => ({ ...branch })),
    };
    setFacilityConfig(nextConfig);

    setFacility(previous => ({
      ...previous,
      name: nextConfig.name,
      code: nextConfig.code,
      type: nextConfig.type,
      departments: nextConfig.departments,
    }));
    setNav('dashboard');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const unsubscribe = authApi.onSessionExpired(() => {
      setRole(null);
      setAuthSession(null);
      setSelectedPatient(null);
      setCStage('pick');
      setPhase('login');
    });

    authApi.restoreSession(controller.signal)
      .then(establishSession)
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRole(null);
        setPhase('login');
        if (!(error instanceof ApiProblemError) || error.status !== 401) {
          setAuthError('The secure authentication service is unavailable.');
        }
      });

    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [establishSession]);

  const handleSelectPatient = (p) => {
    if (!p?.patientId) {
      setSelectedPatient(null);
      setCStage('pick');
      setPatientSearchHid(p?.hid || '');
      setPatientSearchRequestId(requestId => requestId + 1);
      setNav('patients');
      showToast('Verify the patient HID and access before starting an encounter.', 'shield');
      return;
    }
    setSelectedPatient(p);
    setCStage('consult');
  };

  const handleLogout = async () => {
    setRole(null);
    setAuthSession(null);
    setSelectedPatient(null);
    setCStage('pick');
    setPhase('checking');
    try {
      await authApi.logout();
      setAuthError('');
    } catch {
      setAuthError('Local access was closed, but the server could not confirm logout. Close this browser before leaving the workstation.');
    } finally {
      setPatientSearchHid('');
      setPhase('login');
    }
  };

  const handleNavigation = (nextNav) => {
    if (!role?.nav?.includes(nextNav)) {
      showToast('This workflow is not available for the current staff session.', 'shield');
      return;
    }
    setNav(nextNav);
    setActiveModule(null);
    setSelectedPatient(null);
    setCStage('pick');
    setMobileMoreOpen(false);
  };

  if (phase === 'onboarding') {
    return (
      <ToastProvider>
        <SetupWizard
          currentConfig={facilityConfig}
          onLaunchConfig={handleFacilityLaunch}
          onCancel={() => {
            setPhase('signup');
          }}
        />
      </ToastProvider>
    );
  }

  if (phase === 'checking') {
    return (
      <div className="ehr-auth-root fade-in" role="status">
        <div className="ehr-auth-panel">
          <div className="ehr-auth-form">
            <div className="ehr-auth-logo-name">HID EHR</div>
            <p className="ehr-auth-sub">Securing staff session…</p>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'login') {
    return (
      <EhrLogin
        onAuthenticated={establishSession}
        initialError={authError}
        onSignup={() => { setAuthError(''); setPhase('signup'); }}
        onForgot={() => { setAuthError(''); setPhase('forgot'); }}
      />
    );
  }

  if (phase === 'signup') return <EhrSignup onBack={() => setPhase('login')} />;
  if (phase === 'forgot') return <EhrForgot onBack={() => setPhase('login')} />;

  if (!role || !authSession) return null;

  // Module Router Rendering (protected routes)
  const renderModule = () => {
    // If patient is selected in consultation workspace
    if (selectedPatient && cStage === 'consult') {
      return (
        <EncounterWorkspace
          patient={selectedPatient}
          role={role}
          permissions={authSession.actor.permissions || []}
          onBack={() => { setSelectedPatient(null); setCStage('pick'); }}
        />
      );
    }

    switch (nav) {
      case 'dashboard':
        return (
          <RoleDashboard
            role={role}
            facility={facility}
            permissions={authSession.actor.permissions || []}
            onNavigate={handleNavigation}
          />
        );
      case 'patients':
        return <PatientsModule initialHid={patientSearchHid} lookupRequestId={patientSearchRequestId} onSelectPatient={handleSelectPatient} onRegister={() => setNav('identity_link')} />;
      case 'identity_link':
        return <RegistrationModule onRegistered={handleSelectPatient} />;
      case 'setup':
        return (
          <SetupWizard
            currentConfig={facilityConfig}
            onLaunchConfig={handleFacilityLaunch}
            onCancel={() => setNav('dashboard')}
          />
        );
      case 'modules':
        return activeModule
          ? <ModuleWorkspace moduleId={activeModule} onBack={() => setActiveModule(null)} />
          : <ModuleDirectory canConfigureFacility={role.nav.includes('setup')} onNavigate={handleNavigation} onOpenModule={setActiveModule} />;
      default:
        return (
          <RoleDashboard
            role={role}
            facility={facility}
            permissions={authSession.actor.permissions || []}
            onNavigate={handleNavigation}
          />
        );
    }
  };

  return (
    <ToastProvider>
      <div className="ehr-shell">
        {/* Top Header */}
        <TopBar
          role={role}
          facility={facility}
          onLogout={() => { void handleLogout(); }}
          onSearch={(hid) => {
            setPatientSearchHid(hid);
            setPatientSearchRequestId(requestId => requestId + 1);
            setSelectedPatient(null);
            setCStage('pick');
            setNav('patients');
          }}
        />

        {/* Tab Bar Navigation */}
        <TopNav
          nav={nav}
          onNavChange={handleNavigation}
          role={role}
        />

        {/* Main Content Viewport */}
        <main className="ehr-content">
          {renderModule()}
        </main>

        {/* Mobile Navigation Bar (< 768px) */}
        <nav className="ehr-mobilenav" aria-label="Mobile module navigation">
          {NAV_ITEMS.filter(item => ['dashboard', 'patients', 'modules'].includes(item.id) && (role.nav || []).includes(item.id)).map(item => (
            <button
              key={item.id}
              className={`ehr-mobilenav-item ${nav === item.id ? 'active' : ''}`}
              onClick={() => handleNavigation(item.id)}
              aria-current={nav === item.id ? 'page' : undefined}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </button>
          ))}
          <button
            type="button"
            className={`ehr-mobilenav-item ${mobileMoreOpen ? 'active' : ''}`}
            onClick={() => setMobileMoreOpen(value => !value)}
            aria-expanded={mobileMoreOpen}
          >
            <Icon name="more" size={18} />
            <span>More</span>
          </button>
        </nav>
        {mobileMoreOpen && (
          <div className="ehr-mobile-more-scrim" role="presentation" onClick={() => setMobileMoreOpen(false)}>
            <section className="ehr-mobile-more" role="dialog" aria-label="More EHR modules" onClick={event => event.stopPropagation()}>
              <div className="ehr-mobile-more-head">
                <div><strong>More workflows</strong><span>Available in your verified staff session</span></div>
                <button type="button" className="ehr-topbar-icon-btn" onClick={() => setMobileMoreOpen(false)} aria-label="Close more workflows"><Icon name="x" size={18} /></button>
              </div>
              <div className="ehr-mobile-more-grid">
                {NAV_ITEMS.filter(item => !['dashboard', 'patients', 'modules'].includes(item.id) && (role.nav || []).includes(item.id)).map(item => (
                  <button key={item.id} type="button" onClick={() => handleNavigation(item.id)}><Icon name={item.icon} size={17} /><span>{item.label}</span></button>
                ))}
                {!role.nav.some(item => !['dashboard', 'patients', 'modules'].includes(item)) && <p>No additional workflows are enabled for this session.</p>}
              </div>
            </section>
          </div>
        )}
      </div>
    </ToastProvider>
  );
};



export { App };
