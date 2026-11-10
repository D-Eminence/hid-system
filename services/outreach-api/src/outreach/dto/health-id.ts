import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * Identity's own rule for a Health ID (identity-api PatientLookupDto and the
 * CHECK on its column): trimmed, upper case, at most 36 characters. Checked
 * here first so a mistyped Health ID gets Outreach's 400, not Identity's.
 */
export const HEALTH_ID_PATTERN = /^HID-[A-HJ-NP-Z2-9]{6,32}$/;

export function normalizeHealthId({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

/** The property decorators every Health ID field carries. */
export function HealthIdField(): PropertyDecorator {
  return (target, key) => {
    Transform(normalizeHealthId)(target, key);
    IsString()(target, key);
    MaxLength(36)(target, key);
    Matches(HEALTH_ID_PATTERN, { message: 'healthId must be a Health ID such as HID-7KQ2M9XA' })(target, key);
  };
}
