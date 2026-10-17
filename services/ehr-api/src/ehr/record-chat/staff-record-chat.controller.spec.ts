import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, PATIENT_ALLOWED, PATIENT_ONLY, PUBLIC_ROUTE, REQUIRED_PERMISSIONS }
  from '../../common/decorators';
import { StaffRecordChatController } from './staff-record-chat.controller';

const metadata = (key: unknown, target: object) => Reflect.getMetadata(key, target) as unknown;

describe('StaffRecordChatController', () => {
  const prototype = StaffRecordChatController.prototype as unknown as Record<string, object>;

  it('is a staff controller under ehr/patients/:patientId/chat that needs ehr.record-chat.use, never public or patient', () => {
    expect(metadata(PATH_METADATA, StaffRecordChatController)).toBe('ehr/patients/:patientId/chat');
    expect(metadata(REQUIRED_PERMISSIONS, StaffRecordChatController)).toEqual(['ehr.record-chat.use']);
    expect(metadata(AUDIT_FAILURES_ONLY, StaffRecordChatController)).toBe(true);
    for (const key of [PUBLIC_ROUTE, PATIENT_ONLY, PATIENT_ALLOWED]) expect(metadata(key, StaffRecordChatController)).toBeUndefined();
  });

  it.each([
    ['availability', RequestMethod.GET, 'availability', undefined],
    ['ask', RequestMethod.POST, '/', 'ehr.record-chat.staff.ask'],
    ['history', RequestMethod.GET, 'history', undefined],
    ['clear', RequestMethod.DELETE, 'history', undefined],
  ])('routes %s with no route-level override of the permission', (handler, method, path, action) => {
    const route = prototype[handler]!;
    expect(metadata(METHOD_METADATA, route)).toBe(method);
    expect(metadata(PATH_METADATA, route)).toBe(path);
    expect(metadata(AUDIT_ACTION, route)).toBe(action);
    for (const key of [PUBLIC_ROUTE, REQUIRED_PERMISSIONS, PATIENT_ALLOWED]) expect(metadata(key, route)).toBeUndefined();
  });

  it('exposes only these four routes', () => {
    const routes = Object.getOwnPropertyNames(StaffRecordChatController.prototype)
      .filter((name) => name !== 'constructor' && metadata(METHOD_METADATA, prototype[name]!) !== undefined);
    expect(routes.sort()).toEqual(['ask', 'availability', 'clear', 'history']);
  });
});
