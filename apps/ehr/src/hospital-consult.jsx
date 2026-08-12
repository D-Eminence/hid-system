import React from 'react';
import { Badge, Button, Card, PageHead, SectionHeader } from './primitives';

const ClinicalWriteUnavailable = ({ title, onCancel }) => (
  <Card pad>
    <SectionHeader title={title} action={<Badge variant="neutral">Unavailable</Badge>} />
    <p role="status" style={{ margin: 'var(--space-400) 0', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
      This clinical write is disabled until its authenticated, facility-isolated, transactionally audited API is connected.
      No record was created or changed.
    </p>
    {onCancel && <Button variant="secondary" icon="arrowLeft" onClick={onCancel}>Back</Button>}
  </Card>
);

const NoteComposer = ({ onCancel }) => <ClinicalWriteUnavailable title="Clinical Note" onCancel={onCancel} />;
const PrescribeComposer = ({ onCancel }) => <ClinicalWriteUnavailable title="Prescription" onCancel={onCancel} />;
const LabOrderComposer = ({ onCancel }) => <ClinicalWriteUnavailable title="Laboratory Request" onCancel={onCancel} />;

const ConsultWorkspace = ({ patient, role, onBack }) => (
  <div className="fade-in">
    <PageHead
      title="Encounter Workspace"
      sub={`${patient.fullName} • ${patient.hid} • Verified access for ${role.label}`}
      actions={<Button variant="secondary" icon="arrowLeft" onClick={onBack}>Back to Patient Lookup</Button>}
    />
    <Card pad>
      <SectionHeader title="Controlled migration status" action={<Badge variant="neutral">Read only</Badge>} />
      <p role="status" style={{ marginTop: 'var(--space-400)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Identity and access were verified, but encounter creation and clinical recording remain disabled until the EHR API contract is connected.
        No fixture clinical history is displayed and no operation was performed.
      </p>
    </Card>
  </div>
);

export { NoteComposer, PrescribeComposer, LabOrderComposer, ConsultWorkspace };
