import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { DomainProblem, type ProblemDetails } from './problem';

/** The most entries a VALIDATION_FAILED answer lists. */
export const MAX_FIELD_ERRORS = 50;

/**
 * class-validator's errors as Problem Details `errors` (A23). A nested
 * property or array element is named by its dotted path
 * (`replacementValues.systolicMmhg`, `items.0.code`); a top-level entry is as
 * before. A parent that failed only through its children has no entry of its
 * own; one that failed its own rule keeps it, with its children after it.
 * Fields are DTO property names, or the unknown key the client sent; messages
 * are the validators', which never contain the submitted value. At most
 * MAX_FIELD_ERRORS entries are listed.
 */
export function validationFieldErrors(
  errors: readonly ValidationError[],
): NonNullable<ProblemDetails['errors']> {
  // A body within the size limit can refuse hundreds of thousands of array
  // elements; listing one entry each would answer tens of megabytes, so the
  // list stops at MAX_FIELD_ERRORS, in the order class-validator reports.
  const fields: { field: string; messages: string[] }[] = [];
  const visit = (list: readonly ValidationError[], parent?: string): void => {
    for (const error of list) {
      if (fields.length >= MAX_FIELD_ERRORS) return;
      const field = parent === undefined ? error.property : `${parent}.${error.property}`;
      const messages = Object.values(error.constraints ?? {});
      const children = error.children ?? [];
      if (messages.length > 0 || children.length === 0) fields.push({ field, messages });
      visit(children, field);
    }
  };
  visit(errors);
  return fields;
}

/** The 400 VALIDATION_FAILED answer for a refused body, query or route parameter. */
export function validationProblem(errors: ValidationError[]): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
    validationFieldErrors(errors));
}

/** The ValidationPipe main.ts installs for every route. */
export function globalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    stopAtFirstError: false,
    exceptionFactory: validationProblem,
  });
}
