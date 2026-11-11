/**
 * Fictional values for the fields 0122 collects, shared by the specs.
 * Not imported by the application.
 */
export function facilityProfileInput() {
  return {
    tradingName: 'Ada Clinic',
    ownership: 'private' as const,
    careLevel: 'secondary' as const,
    addressLine: '12 Example Road, Yaba',
    city: 'Lagos',
    stateCode: 'LA' as const,
    lga: 'Lagos Mainland',
    gpsLatitude: 6.5244,
    gpsLongitude: 3.3792,
    phone: '+2348012345678',
    email: 'front.desk@clinic.invalid',
    bedCount: 40,
    operatingHours: 'Mon-Sun 24 hours',
    emergency24h: true,
    departments: ['general_outpatient', 'emergency', 'laboratory'] as Array<'general_outpatient' | 'emergency' | 'laboratory'>,
    servicesOffered: 'Outpatient care, emergency care and laboratory tests',
    smohLicenceNumber: 'LSMOH/2024/0001',
    hasRegistryId: false,
    registryId: null,
    hasNhiaAccreditation: true,
    nhiaAccreditationNumber: 'NHIA-0001',
    medicalDirectorName: 'Dr Ada Example',
    medicalDirectorMdcn: 'MDCN/12345',
    expectedStaff: 25,
    migratingRecords: true,
    needsInteroperability: false,
  };
}

/** The sign-up fields 0122 adds to StartProviderEnrollmentDto. */
export function signupCollectedFields() {
  return {
    administratorRole: 'owner' as const,
    administratorPhone: '+2348098765432',
    facilityProfile: facilityProfileInput(),
  };
}

/** The desk fields 0122 adds to ResolveNinDto. */
export function deskCollectedFields() {
  return {
    phone: '+2348011112222',
    addressLine: '4 Example Close, Surulere',
    city: 'Lagos',
    stateCode: 'LA' as const,
    lga: 'Surulere',
    hasExistingHealthId: false,
    existingHealthId: null,
  };
}

/** A 32-byte base64 key for tests only. */
export const TEST_FIELD_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
