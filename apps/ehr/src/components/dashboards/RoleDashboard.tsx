import React from 'react';
import { Badge, Button, Card, Icon, PageHead, SectionHeader } from '@/components/ui/Primitives';
import type { EhrFacilityContext, EhrStaffRole } from '@/types/ehr.types';

interface RoleDashboardProps {
  role: EhrStaffRole;
  facility: EhrFacilityContext;
  permissions: readonly string[];
  onNavigate: (nav: string) => void;
}

const EHR_CAPABILITIES = [
  { label: 'Encounters', read: 'ehr.encounter.read', write: 'ehr.encounter.write', icon: 'stethoscope' as const },
  { label: 'Clinical notes', read: 'ehr.note.read', write: 'ehr.note.write', icon: 'fileText' as const },
  { label: 'Vitals and observations', read: 'ehr.vital.read', write: 'ehr.vital.write', icon: 'activity' as const },
  { label: 'Diagnoses', read: 'ehr.diagnosis.read', write: 'ehr.diagnosis.write', icon: 'clipboard' as const },
  { label: 'Medication requests', read: 'ehr.prescription.read', write: 'ehr.prescription.write', icon: 'pill' as const },
  { label: 'Laboratory requests', read: 'ehr.lab-request.read', write: 'ehr.lab-request.write', icon: 'flask' as const },
  { label: 'Clinical documents', read: 'ehr.document.read', write: 'ehr.document.write', icon: 'fileText' as const },
] as const;

const Metric = ({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: React.ComponentProps<typeof Icon>['name'] }) => (
  <div className="ehr-dashboard-metric">
    <div className="ehr-dashboard-metric-head"><span>{label}</span><Icon name={icon} size={17} /></div>
    <strong>{value}</strong>
    <small>{detail}</small>
  </div>
);

/** Dashboard contains session-derived operational state, never fixture patient data. */
export const RoleDashboard: React.FC<RoleDashboardProps> = ({ role, facility, permissions, onNavigate }) => {
  const canLookupPatient = role.nav.includes('patients');
  const canLinkIdentity = role.nav.includes('identity_link');
  const availableCapabilities = EHR_CAPABILITIES.filter(
    (capability) => permissions.includes(capability.read) || permissions.includes(capability.write),
  );
  const writableCapabilities = availableCapabilities.filter(capability => permissions.includes(capability.write));

  const queues = [
    canLookupPatient ? { label: 'Patient access review', detail: 'Exact HID lookup with facility authorization', action: 'patients', icon: 'search' as const } : null,
    availableCapabilities.some(item => item.label === 'Encounters') ? { label: 'Encounter workspace', detail: 'Open an authorized longitudinal record', action: 'patients', icon: 'stethoscope' as const } : null,
    writableCapabilities.length > 0 ? { label: 'Clinical documentation', detail: `${writableCapabilities.length} write-enabled record areas`, action: 'patients', icon: 'fileText' as const } : null,
  ].filter((queue): queue is NonNullable<typeof queue> => queue !== null);

  return (
    <div className="fade-in ehr-dashboard">
      <PageHead
        title="EHR command center"
        sub={`${role.who} • ${role.label} • ${facility.name}`}
        actions={<Badge variant="blue"><span className="ehr-live-dot" />Verified staff session</Badge>}
      />

      <Card pad className="ehr-dashboard-hero">
        <div>
          <span className="ehr-eyebrow">Today at a glance</span>
          <h2>{role.focus}</h2>
          <p>Use the patient-scoped workspace to begin authorized clinical work. Every record view and write remains tied to your active facility and server permissions.</p>
        </div>
        <div className="ehr-dashboard-hero-actions">
          {canLookupPatient && <Button variant="primary" icon="search" onClick={() => onNavigate('patients')}>Find patient by HID</Button>}
          {canLinkIdentity && <Button variant="secondary" icon="user" onClick={() => onNavigate('identity_link')}>Link existing HID</Button>}
          <Button variant="ghost" icon="grid" onClick={() => onNavigate('modules')}>View modules</Button>
        </div>
      </Card>

      <div className="ehr-grid-4 ehr-dashboard-metrics">
        <Metric label="Authorized record areas" value={`${availableCapabilities.length}`} detail="Available in this session" icon="clipboard" />
        <Metric label="Write-enabled areas" value={`${writableCapabilities.length}`} detail="Server permission derived" icon="edit" />
        <Metric label="Facility departments" value={`${facility.departments.length}`} detail="Active facility context" icon="building" />
        <Metric label="Session permissions" value={`${permissions.length}`} detail="Server session derived" icon="shield" />
      </div>

      <div className="ehr-dashboard-columns">
        <Card pad>
          <SectionHeader title="Work queues" sub="Start with a governed workflow" />
          <div className="ehr-dashboard-queue-list">
            {queues.map(queue => (
              <button key={queue.label} type="button" className="ehr-dashboard-queue" onClick={() => onNavigate(queue.action)}>
                <span className="ehr-dashboard-queue-icon"><Icon name={queue.icon} size={18} /></span>
                <span><strong>{queue.label}</strong><small>{queue.detail}</small></span>
                <Icon name="chevronRight" size={17} />
              </button>
            ))}
            {queues.length === 0 && <p className="ehr-dashboard-empty">No patient workflow is enabled for this session.</p>}
          </div>
        </Card>

        <Card pad>
          <SectionHeader title="Access posture" sub="A quick view of the current authorization boundary" />
          <div className="ehr-dashboard-access-list">
            {EHR_CAPABILITIES.map(capability => {
              const read = permissions.includes(capability.read);
              const write = permissions.includes(capability.write);
              return (
                <div key={capability.label} className="ehr-dashboard-access-row">
                  <span><Icon name={capability.icon} size={15} />{capability.label}</span>
                  <Badge variant={write ? 'blue' : read ? 'neutral' : 'neutral'}>{write ? 'Read + write' : read ? 'Read only' : 'Not assigned'}</Badge>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <Card pad>
        <SectionHeader title="Facility context" sub="Configuration is isolated to this active facility" />
        <div className="ehr-dashboard-context">
          <div><span>Facility</span><strong>{facility.name || 'Not supplied'}</strong></div>
          <div><span>Facility code</span><strong className="mono">{facility.code || 'Not supplied'}</strong></div>
          <div><span>Departments</span><strong>{facility.departments.length || 'None configured'}</strong></div>
          <div><span>Identity boundary</span><Badge variant="blue">HID canonical</Badge></div>
        </div>
      </Card>
    </div>
  );
};
