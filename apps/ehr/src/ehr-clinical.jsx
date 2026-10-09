import React from 'react';
import { Badge, Card, PageHead, SectionHeader } from './primitives';
import { PatientsModule as PatientsModuleTS } from '@/components/clinical/PatientsModule';
import { RegistrationModule as RegistrationModuleTS } from '@/components/clinical/RegistrationModule';

const PatientsModule = (props) => <PatientsModuleTS {...props} />;
const RegistrationModule = (props) => <RegistrationModuleTS {...props} />;

const unavailableModules = {
  triage: ['Triage & Vitals Workspace', 'Vitals capture is unavailable until the audited vitals API is connected.'],
  inpatient: ['Inpatient Wards & Bed Management', 'Ward and admission data is unavailable until its facility-isolated API is connected.'],
  appointments: ['Appointments & Consult Schedule', 'Appointments are unavailable until their backend ownership and audit contract are connected.'],
  emergency: ['Accident & Emergency (A&E)', 'Emergency and break-glass workflows are unavailable until server-side authorization and enhanced auditing are connected.'],
  maternity: ['Maternity & Antenatal Care (ANC)', 'Maternity records are unavailable until their clinical API is connected.'],
  surgery: ['Operating Theatre (OT) & Surgery', 'Surgical records are unavailable until their clinical API is connected.'],
};

const ClinicalModuleUnavailable = ({ moduleId }) => {
  const [title, message] = unavailableModules[moduleId];
  return (
    <div className="fade-in">
      <PageHead title={title} sub="Controlled backend migration" />
      <Card pad>
        <SectionHeader title="Migration status" action={<Badge variant="neutral">Unavailable</Badge>} />
        <p role="status" style={{ marginTop: 'var(--space-400)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {message} No operation was performed and no patient data was loaded.
        </p>
      </Card>
    </div>
  );
};

const TriageModule = () => <ClinicalModuleUnavailable moduleId="triage" />;
const InpatientModule = () => <ClinicalModuleUnavailable moduleId="inpatient" />;
const AppointmentsModule = () => <ClinicalModuleUnavailable moduleId="appointments" />;
const EmergencyModule = () => <ClinicalModuleUnavailable moduleId="emergency" />;
const MaternityModule = () => <ClinicalModuleUnavailable moduleId="maternity" />;
const SurgeryModule = () => <ClinicalModuleUnavailable moduleId="surgery" />;

export { PatientsModule, RegistrationModule, TriageModule, InpatientModule, AppointmentsModule, EmergencyModule, MaternityModule, SurgeryModule };
