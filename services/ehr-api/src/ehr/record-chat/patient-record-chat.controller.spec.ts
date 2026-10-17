import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, PATIENT_ALLOWED, PATIENT_ONLY, PUBLIC_ROUTE,
  REQUIRED_PERMISSIONS } from '../../common/decorators';
import { PatientRecordChatController } from './patient-record-chat.controller';

const metadata = (key: unknown, target: object) => Reflect.getMetadata(key, target) as unknown;

describe('PatientRecordChatController', () => {
  const prototype = PatientRecordChatController.prototype as unknown as Record<string, object>;

  it('is a patient-only controller under ehr/me/chat, never public and needing no staff permission', () => {
    expect(metadata(PATH_METADATA, PatientRecordChatController)).toBe('ehr/me/chat');
    expect(metadata(PATIENT_ONLY, PatientRecordChatController)).toBe(true);
    expect(metadata(PATIENT_ALLOWED, PatientRecordChatController)).toBe(true);
    expect(metadata(FACILITY_OPTIONAL, PatientRecordChatController)).toBe(true);
    expect(metadata(AUDIT_FAILURES_ONLY, PatientRecordChatController)).toBe(true);
    expect(metadata(PUBLIC_ROUTE, PatientRecordChatController)).toBeUndefined();
    expect(metadata(REQUIRED_PERMISSIONS, PatientRecordChatController)).toBeUndefined();
  });

  it.each([
    ['availability', RequestMethod.GET, 'availability', undefined],
    ['ask', RequestMethod.POST, '/', 'ehr.record-chat.ask'],
    ['history', RequestMethod.GET, 'history', 'ehr.record-chat.history.read.request'],
    ['clear', RequestMethod.DELETE, 'history', 'ehr.record-chat.history.clear.request'],
  ])('routes %s with no route-level override of the patient-only rule', (handler, method, path, action) => {
    const route = prototype[handler]!;
    expect(metadata(METHOD_METADATA, route)).toBe(method);
    expect(metadata(PATH_METADATA, route)).toBe(path);
    expect(metadata(AUDIT_ACTION, route)).toBe(action);
    for (const key of [PUBLIC_ROUTE, REQUIRED_PERMISSIONS]) expect(metadata(key, route)).toBeUndefined();
  });

  it('exposes only these four routes', () => {
    const routes = Object.getOwnPropertyNames(PatientRecordChatController.prototype)
      .filter((name) => name !== 'constructor' && metadata(METHOD_METADATA, prototype[name]!) !== undefined);
    expect(routes.sort()).toEqual(['ask', 'availability', 'clear', 'history']);
  });
});
