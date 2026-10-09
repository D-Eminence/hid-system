export type SpecimenStatus = 'required' | 'collected' | 'received' | 'rejected' | 'cancelled' | 'entered_in_error';
export interface LabSpecimenResult {
  id: string; specimenIdentifier: string; requirementId: string; accessionId: string;
  patientId: string; facilityId: string; specimenType: string; containerType: string | null;
  status: SpecimenStatus; collectedAt: Date | null; receivedAt: Date | null;
  rejectedAt: Date | null; rejectionReason: string | null; version: number;
}
export interface LabAccessionResult {
  id: string; accessionNumber: string; workItemId: string; patientId: string; facilityId: string;
  status: 'accessioned'; priority: 'routine' | 'urgent' | 'asap' | 'stat'; version: number;
  createdAt: Date; specimens: LabSpecimenResult[];
}
