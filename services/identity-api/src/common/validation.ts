import { registerDecorator, ValidateIf, type ValidationArguments, type ValidationOptions } from 'class-validator';

/**
 * Marks a property as optional only when it is absent/undefined. Explicit null
 * remains subject to the following validators and is therefore rejected.
 */
export function IsOptionalButNotNull(options?: ValidationOptions): PropertyDecorator {
  return ValidateIf((_object: object, value: unknown) => value !== undefined, options);
}

/** The decorated property may be present only together with `property`. */
export function RequiresProperty(property: string, options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => registerDecorator({
    name: 'requiresProperty',
    target: target.constructor,
    propertyName: String(propertyName),
    constraints: [property],
    options: { message: `${String(propertyName)} requires ${property}`, ...options },
    validator: {
      validate: (value: unknown, args: ValidationArguments) =>
        value === undefined || (args.object as Record<string, unknown>)[property] !== undefined,
    },
  });
}
