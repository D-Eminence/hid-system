import { DomainProblem } from '../../common/problem';
import { isCrossFacilityControlRefusal, orderRouteProblem } from './order-route.problems';

const error = (code: string, message: string) => Object.assign(new Error(message), { code });
const answer = (problem: unknown) => {
  expect(problem).toBeInstanceOf(DomainProblem);
  return { status: (problem as DomainProblem).getStatus(), code: (problem as DomainProblem).code };
};

// SPEC-FINAL §11, every code the EHR's order-route commands can raise.
describe('Order-route refusals (SPEC-FINAL §8.7 conventions, §11)', () => {
  it.each([
    ['ORDER_ROUTE_DESTINATION_INELIGIBLE', 409], ['ORDER_ROUTE_ORDER_NOT_ELIGIBLE', 409], ['ORDER_ROUTE_ORDER_IN_WORK', 409],
    ['ORDER_ROUTE_ALREADY_SENT', 409], ['ORDER_ROUTE_RESEND_LIMIT', 409], ['ORDER_ROUTE_DESTINATION_BUSY', 409],
    ['ORDER_ROUTE_PATIENT_DENIED', 409], ['ORDER_ROUTE_PATIENT_APP_REQUIRED', 409], ['ORDER_ROUTE_ATTESTATION_OUTDATED', 409],
    ['ORDER_ROUTE_NOT_PENDING', 409], ['ORDER_ROUTE_EXPIRED', 409], ['IDEMPOTENCY_KEY_REUSED', 409],
    ['ORDER_ROUTE_SEND_LIMIT', 429], ['ORDER_ROUTE_PAIR_LIMIT', 429],
  ])('answers P0001 %s as %i with that code', (message, status) => {
    expect(answer(orderRouteProblem(error('P0001', message), 'staff'))).toEqual({ status, code: message });
  });

  it('answers P0001 ORDER_ROUTE_VERSION_CONFLICT as 412 VERSION_CONFLICT, for staff and patients', () => {
    expect(answer(orderRouteProblem(error('P0001', 'ORDER_ROUTE_VERSION_CONFLICT'), 'staff')))
      .toEqual({ status: 412, code: 'VERSION_CONFLICT' });
    expect(answer(orderRouteProblem(error('P0001', 'ORDER_ROUTE_VERSION_CONFLICT'), 'patient')))
      .toEqual({ status: 412, code: 'VERSION_CONFLICT' });
  });

  it('answers an unknown P0001 as 503 ORDER_ROUTE_UNAVAILABLE, never the database\'s message', () => {
    const problem = orderRouteProblem(error('P0001', 'SOMETHING_NEW: patient Ada'), 'staff');
    expect(answer(problem)).toEqual({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    expect((problem as DomainProblem).message).not.toContain('Ada');
  });

  it.each([
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled'],
    ['55000', 'PLATFORM_CONTROL_UNAVAILABLE'],
    ['22023', 'PLATFORM_CONTROL_INVALID'],
  ])('answers %s %s as 423 CROSS_FACILITY_ORDERS_UNAVAILABLE (A3)', (code, message) => {
    expect(isCrossFacilityControlRefusal(code, message)).toBe(true);
    expect(answer(orderRouteProblem(error(code, message), 'staff')))
      .toEqual({ status: 423, code: 'CROSS_FACILITY_ORDERS_UNAVAILABLE' });
  });

  it('answers another control\'s refusal or another 55000 as 503, not 423', () => {
    expect(isCrossFacilityControlRefusal('55000', 'PLATFORM_CONTROL_DISABLED:maintenance_mode')).toBe(false);
    expect(answer(orderRouteProblem(error('55000', 'PLATFORM_CONTROL_DISABLED:maintenance_mode'), 'staff')))
      .toEqual({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    expect(answer(orderRouteProblem(error('55000', 'ORDER_ROUTE_IMMUTABLE'), 'staff')))
      .toEqual({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
  });

  it('answers 22023 as 400 ORDER_ROUTE_INVALID', () => {
    expect(answer(orderRouteProblem(error('22023', 'ORDER_ROUTE_INVALID'), 'staff')))
      .toEqual({ status: 400, code: 'ORDER_ROUTE_INVALID' });
  });

  it('answers 42501 as 403 PERMISSION_DENIED for staff and PATIENT_SESSION_REQUIRED for a patient', () => {
    expect(answer(orderRouteProblem(error('42501', 'ORDER_ROUTE_PERMISSION_DENIED'), 'staff')))
      .toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    expect(answer(orderRouteProblem(error('42501', 'permission denied for function x'), 'patient')))
      .toEqual({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
  });

  it('answers P0002 as 404 ORDER_NOT_FOUND or ORDER_ROUTE_NOT_FOUND', () => {
    expect(answer(orderRouteProblem(error('P0002', 'ORDER_NOT_FOUND'), 'staff', 'ORDER_ROUTE_NOT_FOUND')))
      .toEqual({ status: 404, code: 'ORDER_NOT_FOUND' });
    expect(answer(orderRouteProblem(error('P0002', 'ORDER_ROUTE_NOT_FOUND'), 'staff', 'ORDER_NOT_FOUND')))
      .toEqual({ status: 404, code: 'ORDER_ROUTE_NOT_FOUND' });
    expect(answer(orderRouteProblem(error('P0002', 'not found'), 'staff', 'ORDER_NOT_FOUND')))
      .toEqual({ status: 404, code: 'ORDER_NOT_FOUND' });
    expect(answer(orderRouteProblem(error('P0002', 'not found'), 'patient')))
      .toEqual({ status: 404, code: 'ORDER_ROUTE_NOT_FOUND' });
  });

  it.each(['23505', '23514', '40001', '40P01', '08006'])('answers %s as 503 ORDER_ROUTE_UNAVAILABLE', (code) => {
    expect(answer(orderRouteProblem(error(code, 'x'), 'staff'))).toEqual({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
  });

  it('passes a domain problem and a non-database error through unchanged', () => {
    const problem = new DomainProblem(409, 'X', 'x');
    expect(orderRouteProblem(problem, 'staff')).toBe(problem);
    const defect = new TypeError('defect');
    expect(orderRouteProblem(defect, 'staff')).toBe(defect);
  });
});
