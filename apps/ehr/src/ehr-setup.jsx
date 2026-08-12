import React from 'react';
import { Button, Badge, Field, Input, Select, showToast } from '@/components/ui/Primitives';
import { ROLES, DEPARTMENTS, FACILITY_TYPES, TYPE_PRESETS, enabledModules, enabledRoleKeys, HOSPITAL_CONFIG } from './ehr-data';

/* ehr-setup.jsx - Facility onboarding wizard for a facility-provided configuration. */

const CURRENCY_OPTIONS = [
  { value: 'NGN', label: 'Nigerian Naira (NGN)' },
  { value: 'USD', label: 'US Dollar (USD)' },
  { value: 'GBP', label: 'British Pound (GBP)' },
  { value: 'EUR', label: 'Euro (EUR)' },
];

const TIMEZONE_OPTIONS = [
  { value: 'Africa/Lagos', label: 'Africa/Lagos' },
  { value: 'Africa/Accra', label: 'Africa/Accra' },
  { value: 'Africa/Nairobi', label: 'Africa/Nairobi' },
  { value: 'Africa/Johannesburg', label: 'Africa/Johannesburg' },
];

const STEP_LABELS = ['Facility', 'Type', 'Departments', 'Branches', 'Staff', 'Roles', 'Billing', 'Review', 'Launch'];

const SetupWizard = ({ currentConfig = HOSPITAL_CONFIG, onLaunchConfig, onCancel }) => {
  const [step, setStep] = React.useState(1);
  const [config, setConfig] = React.useState({
    name: currentConfig.name || '',
    code: currentConfig.code || '',
    type: currentConfig.type || '',
    departments: [...(currentConfig.departments || [])],
    multiBranch: currentConfig.multiBranch || false,
    branches: currentConfig.branches?.length
      ? currentConfig.branches
      : [{ id: 'main', name: '', code: '' }],
    currency: currentConfig.currency || '',
    timezone: currentConfig.timezone || '',
    hmoIntegrated: currentConfig.hmoIntegrated ?? false,
  });

  const totalSteps = 9;

  const handleTypeSelect = (typeId) => {
    const presetDepts = TYPE_PRESETS[typeId] || [];
    setConfig(prev => ({
      ...prev,
      type: typeId,
      departments: [...presetDepts]
    }));
  };

  const toggleDept = (did) => {
    setConfig(prev => {
      const depts = prev.departments.includes(did)
        ? prev.departments.filter(d => d !== did)
        : [...prev.departments, did];
      return { ...prev, departments: depts };
    });
  };

  const handleFinish = () => {
    if (!config.name.trim() || !config.code.trim()) {
      showToast('Facility name and code are required.', 'alertTriangle');
      setStep(1);
      return;
    }
    if (!config.branches.length || config.branches.some(branch => !branch.name.trim() || !branch.code.trim())) {
      showToast('Each campus needs a name and code.', 'alertTriangle');
      setStep(4);
      return;
    }
    showToast('Facility configuration saved.', 'check');
    onLaunchConfig && onLaunchConfig(config);
  };

  const updateBranch = (index, field, value) => {
    setConfig(prev => ({
      ...prev,
      branches: prev.branches.map((branch, branchIndex) => branchIndex === index ? { ...branch, [field]: value } : branch),
    }));
  };

  const addBranch = () => {
    setConfig(prev => ({
      ...prev,
      multiBranch: true,
      branches: [...prev.branches, { id: `campus-${prev.branches.length + 1}`, name: '', code: '' }],
    }));
  };

  const removeBranch = (index) => {
    if (index === 0) return;
    setConfig(prev => ({ ...prev, branches: prev.branches.filter((_, branchIndex) => branchIndex !== index) }));
  };

  let canContinue = true;
  if (step === 1) canContinue = Boolean(config.name.trim() && config.code.trim());
  if (step === 2) canContinue = Boolean(config.type);
  if (step === 3) canContinue = Boolean(config.departments.length);
  if (step === 4) canContinue = Boolean(config.branches.length && config.branches.every(branch => branch.name.trim() && branch.code.trim()));
  if (step === 7) canContinue = Boolean(config.currency && config.timezone);

  return (
    <div className="ehr-setup-root fade-in">
      <div className="ehr-setup-card">
        {/* Wizard Header */}
        <div className="ehr-setup-head">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-400)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-300)' }}>
              <div style={{ width: 32, height: 32, borderRadius: 'var(--radius-md)', background: 'var(--accent)', color: '#fff', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                HID
              </div>
              <span style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--text-heading)' }}>Facility Onboarding</span>
            </div>
            <Badge variant="blue">Step {step} of {totalSteps}</Badge>
          </div>

          {/* Reference onboarding sequence */}
          <div className="ehr-setup-steps">
            {STEP_LABELS.map((label, i) => {
              const idx = i + 1;
              const cls = idx === step ? 'active' : idx < step ? 'done' : '';
              return (
                <div key={label} className={`ehr-setup-step-marker ${cls}`} aria-current={idx === step ? 'step' : undefined}>
                  <span className="ehr-setup-step-dot">{idx < step ? 'OK' : idx}</span>
                  <span className="ehr-setup-step-label">{label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Wizard Body */}
        <div className="ehr-setup-body">
          {/* Step 1: Facility Name */}
          {step === 1 && (
            <div>
              <h3 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 700, color: 'var(--text-heading)', marginBottom: 8 }}>1. Facility Identity</h3>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 24 }}>Enter your hospital or healthcare institution name and details.</p>

              <Field label="Hospital / Facility Name" required>
                <Input
                  value={config.name}
                  onChange={e => setConfig({ ...config, name: e.target.value })}
                  placeholder="Enter facility name"
                />
              </Field>
              <Field label="Facility Code" required>
                <Input
                  value={config.code}
                  onChange={e => setConfig({ ...config, code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16) })}
                  placeholder="Enter facility code"
                />
              </Field>
            </div>
          )}

          {/* Step 2: Facility Type */}
          {step === 2 && (
            <div>
              <h3 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 700, color: 'var(--text-heading)', marginBottom: 8 }}>2. Select Facility Tier Type</h3>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 24 }}>Choosing a type automatically selects recommended department presets.</p>

              <div className="ehr-grid-2">
                {FACILITY_TYPES.map(ft => (
                  <button
                    type="button"
                    key={ft.id}
                    className={`ehr-dept-card ${config.type === ft.id ? 'selected' : ''}`}
                    onClick={() => handleTypeSelect(ft.id)}
                    aria-pressed={config.type === ft.id}
                    style={{ width: '100%', textAlign: 'left' }}
                  >
                    <div>
                      <div style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--text-heading)' }}>{ft.label}</div>
                      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginTop: 4 }}>{ft.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Department Selection */}
          {step === 3 && (
            <div>
              <h3 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 700, color: 'var(--text-heading)', marginBottom: 8 }}>3. Modular Department Selection</h3>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 16 }}>
                Select the departments to include in this facility's local configuration plan. Clinical EHR access still comes from the verified staff session.
              </p>

              <div className="ehr-dept-grid">
                {Object.values(DEPARTMENTS).map(dept => {
                  const isSelected = config.departments.includes(dept.id);
                  return (
                    <button
                      type="button"
                      key={dept.id}
                      className={`ehr-dept-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => !dept.core && toggleDept(dept.id)}
                      disabled={dept.core}
                      aria-pressed={isSelected}
                      style={{ opacity: dept.core ? 0.85 : 1, cursor: dept.core ? 'not-allowed' : 'pointer' }}
                    >
                      <span aria-hidden="true" style={{ width: 18, height: 18, border: '1px solid var(--border-control)', borderRadius: 4, background: isSelected ? 'var(--accent)' : 'var(--surface)', color: 'var(--text-on-accent)', display: 'grid', placeItems: 'center', fontSize: 10, flexShrink: 0 }}>{isSelected ? 'OK' : ''}</span>
                      <div>
                        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 700, color: 'var(--text-heading)' }}>
                          {dept.label} {dept.core && <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>(Core)</span>}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: 2 }}>
                          {dept.modules.length} modules • {dept.roles.length} roles
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 4: Multi-Branch */}
          {step === 4 && (
            <div>
              <h3 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 700, color: 'var(--text-heading)', marginBottom: 8 }}>4. Multi-Branch & Campus Setup</h3>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 24 }}>Define the campuses represented by this local facility configuration.</p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 'var(--fs-md)', cursor: 'pointer' }}>
                <input type="checkbox" checked={config.multiBranch} onChange={e => setConfig({ ...config, multiBranch: e.target.checked })} style={{ accentColor: 'var(--accent)', width: 18, height: 18 }} />
                Include multiple campuses in the configuration
              </label>
              <div className="ehr-branch-list" style={{ marginTop: 24 }}>
                {config.branches.map((branch, index) => (
                  <div className="ehr-branch-row" key={branch.id}>
                    <div className="ehr-branch-row-head">
                      <strong>{index === 0 ? 'Primary campus' : `Campus ${index + 1}`}</strong>
                      {index > 0 && <Button variant="ghost" icon="trash" onClick={() => removeBranch(index)} aria-label={`Remove campus ${index + 1}`} />}
                    </div>
                    <div className="ehr-grid-2">
                      <Field label="Campus Name" required>
                        <Input value={branch.name} onChange={e => updateBranch(index, 'name', e.target.value)} placeholder="Enter campus name" />
                      </Field>
                      <Field label="Campus Code" required>
                        <Input value={branch.code} onChange={e => updateBranch(index, 'code', e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12))} placeholder="Enter campus code" />
                      </Field>
                    </div>
                  </div>
                ))}
                {config.multiBranch && <Button variant="secondary" icon="plus" onClick={addBranch}>Add campus</Button>}
              </div>
            </div>
          )}

          {/* Step 5: Staff */}
          {step === 5 && (
            <div>
              <h3 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 700, color: 'var(--text-heading)', marginBottom: 8 }}>5. Staff Onboarding</h3>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 16 }}>
                Prepare staff access for the selected departments. Production invitations and credentials remain governed by HID Identity.
              </p>
              <div className="ehr-setup-summary-list">
                <div><span>Configured departments</span><strong>{config.departments.length}</strong></div>
                <div><span>Campuses receiving staff access</span><strong>{config.branches.length}</strong></div>
                <div><span>Staff provisioning</span><Badge variant="neutral">HID Identity required</Badge></div>
              </div>
            </div>
          )}

          {/* Step 6: Roles */}
          {step === 6 && (
            <div>
              <h3 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 700, color: 'var(--text-heading)', marginBottom: 8 }}>6. Roles & Access Preview</h3>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 16 }}>
                The department plan enables {enabledRoleKeys(config.departments).size} role templates. Actual grants still come from the authenticated server session.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {ROLES.filter(r => enabledRoleKeys(config.departments).has(r.key)).map(r => (
                  <Badge key={r.key} variant="blue">{r.label} ({r.tierLabel})</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Step 7: Billing & HMO */}
          {step === 7 && (
            <div>
              <h3 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 700, color: 'var(--text-heading)', marginBottom: 8 }}>7. Billing & Insurance Preferences</h3>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 24 }}>Record the facility's preferred currency, timezone, and HMO planning flag for this local configuration.</p>
              <Field label="Currency Unit">
                <Select value={config.currency} onChange={e => setConfig({ ...config, currency: e.target.value })} options={CURRENCY_OPTIONS} />
              </Field>
              <Field label="Facility Timezone">
                <Select value={config.timezone} onChange={e => setConfig({ ...config, timezone: e.target.value })} options={TIMEZONE_OPTIONS} />
              </Field>
              <label style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 'var(--fs-md)', cursor: 'pointer' }}>
                <input type="checkbox" checked={config.hmoIntegrated} onChange={e => setConfig({ ...config, hmoIntegrated: e.target.checked })} style={{ accentColor: 'var(--accent)', width: 18, height: 18 }} />
                Include HMO / insurance in the facility plan
              </label>
            </div>
          )}

          {/* Step 8: Review */}
          {step === 8 && (
            <div>
              <h3 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 700, color: 'var(--text-heading)', marginBottom: 8 }}>8. Review Facility Configuration</h3>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 24 }}>Confirm the local facility plan before launch.</p>
              <div className="ehr-setup-summary-list">
                <div><span>Facility</span><strong>{config.name} ({config.code})</strong></div>
                <div><span>Type</span><strong>{config.type.replaceAll('_', ' ')}</strong></div>
                <div><span>Departments / modules</span><strong>{config.departments.length} / {enabledModules(config.departments).size}</strong></div>
                <div><span>Campuses</span><strong>{config.branches.length}</strong></div>
                <div><span>HID identity boundary</span><Badge variant="blue">Enabled</Badge></div>
                <div><span>Audit and break-glass policy</span><Badge variant="neutral">Server enforced</Badge></div>
              </div>
            </div>
          )}

          {/* Step 9: Confirm & Launch */}
          {step === 9 && (
            <div>
              <h3 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 700, color: 'var(--text-heading)', marginBottom: 8 }}>9. Launch Facility Workspace</h3>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 24 }}>Review and save the facility-provided configuration.</p>
              <div style={{ background: 'var(--surface-info)', padding: 16, borderRadius: 'var(--radius-xl)', fontSize: 'var(--fs-sm)' }}>
                <div>Facility: <strong>{config.name}</strong></div>
                <div>Facility Code: <strong>{config.code}</strong></div>
                <div>Tier: <strong>{config.type.replace('_', ' ').toUpperCase()}</strong></div>
                <div>Primary Campus: <strong>{config.branches[0]?.name || 'Not configured'}</strong></div>
                <div>Campuses: <strong>{config.branches.map(branch => branch.name).join(', ')}</strong></div>
                <div>Enabled Departments: <strong>{config.departments.length} Departments</strong></div>
                <div>Configured Catalog Modules: <strong>{enabledModules(config.departments).size} Modules</strong></div>
              </div>
            </div>
          )}
        </div>

        {/* Wizard Footer */}
        <div className="ehr-setup-foot">
          <Button variant="secondary" onClick={() => step === 1 ? onCancel?.() : setStep(step - 1)} icon="arrowLeft">
            {step === 1 ? 'Cancel' : 'Back'}
          </Button>
          {step < totalSteps ? (
            <Button variant="primary" disabled={!canContinue} onClick={() => setStep(step + 1)} iconRight="arrowRight">
              Next Step
            </Button>
          ) : (
            <Button variant="primary" onClick={handleFinish} icon="check">
              Enter EHR Workspace
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};



export { SetupWizard };
