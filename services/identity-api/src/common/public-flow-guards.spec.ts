import { DomainProblem } from './problem';
import { assertAccountless } from './public-flow-guards';
import type { HidRequest } from './request-context';

/**
 * The accountless check of the public flows (provider self-enrollment,
 * clinician self sign-up). On their routes the browser sends the access
 * cookie and the CSRF cookie (both path '/'), never the refresh cookie (path
 * '/api/v1/auth'). Once the 15-minute access cookie expires, the CSRF cookie,
 * which lives as long as the refresh session, is the only sign of a live
 * sign-in.
 */
const refusal = { code: 'SYNTHETIC_REQUIRES_SIGN_OUT', detail: 'Sign out first' };
const request = (headers: Record<string, string>) => ({
  header: (name: string) => headers[name.toLowerCase()],
}) as unknown as HidRequest;
const refused = (headers: Record<string, string>) => {
  try {
    assertAccountless(request(headers), 'hid_access', refusal);
    return undefined;
  } catch (error) {
    return error as DomainProblem;
  }
};

describe('assertAccountless', () => {
  it.each([
    ['the access cookie', { cookie: 'hid_access=token' }],
    ['the CSRF cookie alone (the access cookie expired, the refresh session lives)', { cookie: 'hid_access_csrf=token' }],
    ['the CSRF cookie among others', { cookie: 'theme=dark; hid_access_csrf=token; hid_clinician_application=x' }],
    ['the refresh cookie (where a client sends it)', { cookie: 'hid_access_refresh=token' }],
    ['an Authorization header', { authorization: 'Bearer token' }],
  ])('refuses a request with %s', (_label, headers) => {
    const problem = refused(headers);
    expect(problem).toBeInstanceOf(DomainProblem);
    expect([problem!.getStatus(), problem!.code]).toEqual([409, 'SYNTHETIC_REQUIRES_SIGN_OUT']);
  });

  it.each([
    ['no cookie', {}],
    ['only the flow\'s own cookies', { cookie: 'hid_clinician_application=x; hid_provider_enrollment=y' }],
    ['a cookie that only begins with the name', { cookie: 'hid_access_csrfx=token; xhid_access=token' }],
  ])('lets a request with %s through', (_label, headers) => {
    expect(refused(headers)).toBeUndefined();
  });
});
