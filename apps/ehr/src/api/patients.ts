import type { IdentityPatientSummary } from './contracts';
import type { Patient } from '@/types/ehr.types';

const calculateAge = (dateOfBirth?: string): number | undefined => {
  if (!dateOfBirth) return undefined;
  const birthDate = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(birthDate.getTime())) return undefined;

  const today = new Date();
  let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
  const birthdayHasPassed =
    today.getUTCMonth() > birthDate.getUTCMonth()
    || (today.getUTCMonth() === birthDate.getUTCMonth()
      && today.getUTCDate() >= birthDate.getUTCDate());
  if (!birthdayHasPassed) age -= 1;
  return age >= 0 ? age : undefined;
};

export const toPatientViewModel = (patient: IdentityPatientSummary): Patient => {
  const derivedName = [patient.firstName, patient.lastName].filter(Boolean).join(' ');
  return {
    patientId: patient.patientId,
    hid: patient.hid,
    mrn: patient.mrn,
    firstName: patient.firstName,
    lastName: patient.lastName,
    fullName: patient.fullName ?? (derivedName || 'Name unavailable'),
    dob: patient.dateOfBirth,
    age: calculateAge(patient.dateOfBirth),
    sex: patient.sex,
    bloodGroup: patient.bloodGroup,
    phone: patient.phone,
    registrationDate: patient.registrationDate,
    lastVisit: patient.lastVisit,
    status: patient.status ?? 'unknown',
  };
};
