import { ValidateBy, ValidateIf, buildMessage, type ValidationOptions } from 'class-validator';

/**
 * Marks a property as optional only when it is absent/undefined. Explicit null
 * remains subject to the following validators and is therefore rejected.
 */
export function IsOptionalButNotNull(options?: ValidationOptions): PropertyDecorator {
  return ValidateIf((_object: object, value: unknown) => value !== undefined, options);
}

/**
 * A text of at least `min` characters once the spaces at either end are taken
 * off, as the database counts it: the service stores the trimmed text and a
 * check such as length(btrim(reason)) between 3 and 500 counts its
 * characters, so a character outside the Basic Multilingual Plane counts once.
 * A value that is not a string is left to @IsString, so it gets one message.
 */
export function MinTrimmedLength(min: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({
    name: 'minTrimmedLength',
    constraints: [min],
    validator: {
      validate: (value: unknown) => typeof value !== 'string' || [...value.trim()].length >= min,
      defaultMessage: buildMessage((each) => `${each}$property must be at least ${min} characters`, options),
    },
  }, options);
}
