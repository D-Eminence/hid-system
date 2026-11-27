import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { DomainProblem } from './problem';

/** The fields a VALIDATION_FAILED answer names, each with its messages. */
export type ValidationFields = (errors: ValidationError[]) => { field: string; messages: string[] }[];

/** Each top-level field the body got wrong, with its own messages (every route's answer). */
const topLevelFields: ValidationFields = (errors) => errors.map((error) => ({
  field: error.property,
  messages: Object.values(error.constraints ?? {}),
}));

/**
 * The request validation of every route (main.ts installs it globally): only
 * a body's declared fields, explicit types, and a field that is not declared
 * is refused as 400 VALIDATION_FAILED, "property X should not exist". A route
 * whose body class depends on a setting (CreatePrescriptionBodyPipe) runs the
 * same validation with the class it picks, so both answer alike. A route may
 * name nested fields its own way (`fieldsOf`; ORD-6's group names
 * `tests.<n>.<field>`); every other route keeps the top-level fields.
 */
export function createValidationPipe(fieldsOf: ValidationFields = topLevelFields): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    stopAtFirstError: false,
    exceptionFactory: (errors) => new DomainProblem(
      400,
      'VALIDATION_FAILED',
      'One or more request fields are invalid.',
      fieldsOf(errors),
    ),
  });
}
