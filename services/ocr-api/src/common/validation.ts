import { ValidateIf, type ValidationOptions } from 'class-validator';

/**
 * Marks a property as optional only when it is absent/undefined. Explicit null
 * remains subject to the following validators and is therefore rejected.
 */
export function IsOptionalButNotNull(options?: ValidationOptions): PropertyDecorator {
  return ValidateIf((_object: object, value: unknown) => value !== undefined, options);
}

