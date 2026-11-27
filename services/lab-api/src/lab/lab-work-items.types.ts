export interface AcceptEhrLabOrderCommand {
  sourceEhrOrderId: string;
  sourceEhrOrderVersion: number;
  sourceEncounterId: string;
  patientId: string;
  orderingFacilityId: string;
  /** Both null (or left out) for a test ordered by its name only (0156); both or neither. */
  testCodeSystem?: string | null;
  testCode?: string | null;
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
  /**
   * ORD-6 (0158): this facility's own work item's EHR order group, which
   * Lab's validator copied from the EHR row; null for a request ordered on
   * its own. Absent on a work item from another facility's order route, which
   * never carries one.
   */
  requestGroupId?: string | null;
  sourceEhrOrderVersion: number;
  status: 'accepted';
  priority: AcceptEhrLabOrderCommand['priority'];
  acceptedAt: string | Date;
  version: number;
  /** A route-backed work item's route (P4c, SPEC-FINAL §10.2). */
  orderRoute?: import('./order-route-cards').WorkItemOrderRoute;
  /**
   * Its patient: on a route-backed work item only while the route allows a
   * read (P10.5); on this facility's own work item only while
   * OWN_WORK_PATIENT_CARD_ENABLED is on and the member may read it (0124).
   */
  patient?: import('./order-route-cards').WorkItemRoutePatient;
  /**
   * The request's clinical information (null when the EHR sent none), on the
   * reads of a same-facility work item only: never on a route-backed one, and
   * not in the acceptance answer.
   */
  clinicalIndication?: string | null;
}
