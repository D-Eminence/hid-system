import React from 'react';
import { Badge, Card, PageHead, SectionHeader } from './primitives';

const moduleTitles = {
  shifts: 'Shifts & Staff Roster',
  hr: 'Human Resources',
  quality: 'Quality & Clinical Governance',
  insurance: 'HMO & Insurance',
  inventory: 'Inventory & Stores',
  ambulance: 'Ambulance & Dispatch',
  bloodBank: 'Blood Bank',
  telemedicine: 'Telemedicine',
  referrals: 'Referrals & Field Outreach',
};

const UnavailableModule = ({ moduleId }) => (
  <div className="fade-in">
    <PageHead title={moduleTitles[moduleId]} sub="Controlled backend migration" />
    <Card pad>
      <SectionHeader title="Migration status" action={<Badge variant="neutral">Unavailable</Badge>} />
      <p role="status" style={{ marginTop: 'var(--space-400)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        This module remains unavailable until its authenticated, facility-isolated, audited API contract is connected.
        No operation was performed and no patient data was loaded.
      </p>
    </Card>
  </div>
);

const ShiftsModule = () => <UnavailableModule moduleId="shifts" />;
const HRModule = () => <UnavailableModule moduleId="hr" />;
const QualityModule = () => <UnavailableModule moduleId="quality" />;
const InsuranceModule = () => <UnavailableModule moduleId="insurance" />;
const InventoryModule = () => <UnavailableModule moduleId="inventory" />;
const AmbulanceModule = () => <UnavailableModule moduleId="ambulance" />;
const BloodBankModule = () => <UnavailableModule moduleId="bloodBank" />;
const TelemedicineModule = () => <UnavailableModule moduleId="telemedicine" />;
const ReferralsModule = () => <UnavailableModule moduleId="referrals" />;

export { ShiftsModule, HRModule, QualityModule, InsuranceModule, InventoryModule, AmbulanceModule, BloodBankModule, TelemedicineModule, ReferralsModule };
