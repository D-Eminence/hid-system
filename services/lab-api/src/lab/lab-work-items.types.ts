export interface AcceptEhrLabOrderCommand {
  sourceEhrOrderId: string;
  sourceEhrOrderVersion: number;
  sourceEncounterId: string;
  patientId: string;
  orderingFacilityId: string;
  testCodeSystem: string;
  testCode: string;
  testName: string;
  priority: 'routine' | 'urgent' | 'asap' | 'stat';
  clinicalIndication?: string;
  requestedBy: string;
  requestedAt: string;
}

export interface LabWorkItemResult {
  id: string;
  patientId: string;
  facilityId: string;
  sourceEhrOrderId: string;
  sourceEhrOrderVersion: number;
  status: 'accepted';
  priority: AcceptEhrLabOrderCommand['priority'];
  acceptedAt: string | Date;
  version: number;
}
