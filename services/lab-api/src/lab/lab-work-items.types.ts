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
  /** Absent on a work item from another facility's order route (P4c, PRIV P4.3). */
  sourceEhrOrderId?: string;
  sourceEhrOrderVersion: number;
  status: 'accepted';
  priority: AcceptEhrLabOrderCommand['priority'];
  acceptedAt: string | Date;
  version: number;
  /** A route-backed work item's route (P4c, SPEC-FINAL §10.2). */
  orderRoute?: import('./order-route-cards').WorkItemOrderRoute;
  /** Its patient, only while the route allows a read (P10.5). */
  patient?: import('./order-route-cards').WorkItemRoutePatient;
}
