import { ValidationPipe } from '@nestjs/common';
import { DomainProblem } from './problem';

/**
 * The request validation of every route (main.ts installs it globally): only
 * a body's declared fields, explicit types, and a field that is not declared
 * is refused as 400 VALIDATION_FAILED, "property X should not exist". A route
 * whose body class depends on a setting (CreatePrescriptionBodyPipe) runs the
 * same validation with the class it picks, so both answer alike.
 */
export function createValidationPipe(): ValidationPipe {
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
      errors.map((error) => ({
        field: error.property,
        messages: Object.values(error.constraints ?? {}),
      })),
    ),
  });
}
