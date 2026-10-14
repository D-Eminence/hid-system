import type { LoginDto } from './dto/login.dto';

type LoginAction = NonNullable<LoginDto['turnstileAction']>;
export type TurnstileAction = LoginAction | 'patient-reset-start' | 'staff-reset'
  | 'admin-reset' | 'legacy-recovery' | 'book-demo' | 'organization-application'
  | 'organization-completion'
  | 'patient-enrollment' | 'provider-enrollment';
export type TurnstileDeployment = 'staging' | 'production';

function deploymentActions(value: Record<string, readonly TurnstileAction[]>): Readonly<Record<string, readonly TurnstileAction[]>> {
  return Object.freeze(value);
}

/**
 * The Turnstile actions each browser host may present, per deployment profile.
 * TurnstileService refuses any other host and action pair before calling
 * Cloudflare, and the configuration refuses a CORS origin with no entry here
 * (TS-9). It has no dependencies so the configuration can read it.
 */
const ACTIONS_BY_DEPLOYMENT: Readonly<Record<TurnstileDeployment, Readonly<Record<string, readonly TurnstileAction[]>>>> = Object.freeze({
  production: deploymentActions({
    'www.healthidentitydirectory.com': [
      'patient-login', 'staff-login', 'admin-login', 'patient-reset-start',
      'staff-reset', 'admin-reset', 'legacy-recovery', 'book-demo', 'organization-application',
      'organization-completion',
      'patient-enrollment', 'provider-enrollment',
    ],
    'ehr.healthidentitydirectory.com': ['ehr-login', 'staff-login'],
    'lab.healthidentitydirectory.com': ['lab-login'],
    'pharmacy.healthidentitydirectory.com': ['pharmacy-login'],
    'migrate.healthidentitydirectory.com': ['ocr-login'],
    'outreach.healthidentitydirectory.com': ['outreach-login'],
    'admin.healthidentitydirectory.com': ['admin-login', 'admin-reset'],
  }),
  staging: deploymentActions({
    'staging.healthidentitydirectory.com': [
      'patient-login', 'staff-login', 'admin-login', 'patient-reset-start',
      'staff-reset', 'admin-reset', 'legacy-recovery', 'book-demo', 'organization-application',
      'organization-completion',
      'patient-enrollment', 'provider-enrollment',
    ],
    'ehr.staging.healthidentitydirectory.com': ['ehr-login', 'staff-login'],
    'lab.staging.healthidentitydirectory.com': ['lab-login'],
    'pharmacy.staging.healthidentitydirectory.com': ['pharmacy-login'],
    'migrate.staging.healthidentitydirectory.com': ['ocr-login'],
    'outreach.staging.healthidentitydirectory.com': ['outreach-login'],
    'admin.staging.healthidentitydirectory.com': ['admin-login', 'admin-reset'],
  }),
});

/** The actions a host may present in a deployment profile; undefined for a host with none. */
export function turnstileActionsFor(deployment: TurnstileDeployment, hostname: string): readonly TurnstileAction[] | undefined {
  return Object.hasOwn(ACTIONS_BY_DEPLOYMENT[deployment], hostname) ? ACTIONS_BY_DEPLOYMENT[deployment][hostname] : undefined;
}
