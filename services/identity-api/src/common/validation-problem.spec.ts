import { Type } from 'class-transformer';
import { IsArray, IsInt, IsObject, Max, ValidateNested } from 'class-validator';
import { ListAuditEventsDto } from '../audit/dto/list-audit-events.dto';
import { DomainProblem } from './problem';
import { globalValidationPipe, MAX_FIELD_ERRORS } from './validation-problem';

/**
 * Generic nested shapes. Identity's own nested body, the in-person check of
 * ADR-063, is pinned in identity/assisted-registration.spec.ts.
 */
class Inner {
  @IsInt()
  @Max(5)
  count!: number;
}

class Wrap {
  @IsObject()
  @ValidateNested()
  @Type(() => Inner)
  inner!: Inner;
}

class InnerList {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Inner)
  inners!: Inner[];
}

/** Runs a request value through main.ts's pipe and returns the refusal's `errors`. */
async function refusal(value: unknown, metatype: new () => object, type: 'body' | 'query' = 'body') {
  const rejected = await globalValidationPipe().transform(value, { type, metatype })
    .then(() => undefined, (error: unknown) => error);
  expect(rejected).toBeInstanceOf(DomainProblem);
  const problem = rejected as DomainProblem;
  expect([problem.getStatus(), problem.code, problem.message])
    .toEqual([400, 'VALIDATION_FAILED', 'One or more request fields are invalid.']);
  return problem.errors;
}

describe('VALIDATION_FAILED field paths (A23)', () => {
  it('names a refused nested property by its dotted path, without the submitted value', async () => {
    const errors = await refusal({ inner: { count: 9 } }, Wrap);
    expect(errors).toEqual([{ field: 'inner.count', messages: ['count must not be greater than 5'] }]);
    expect(JSON.stringify(errors)).not.toContain('9');
  });

  it('names an unknown nested property by its path', async () => {
    const errors = await refusal({ inner: { count: 1, extra: true } }, Wrap);
    expect(errors).toEqual([{ field: 'inner.extra', messages: ['property extra should not exist'] }]);
  });

  it('leaves top-level entries as they were', async () => {
    expect(await refusal({ limit: '500' }, ListAuditEventsDto, 'query'))
      .toEqual([{ field: 'limit', messages: ['limit must not be greater than 200'] }]);
    expect(await refusal({ limit: '5', foo: 'x' }, ListAuditEventsDto, 'query'))
      .toEqual([{ field: 'foo', messages: ['property foo should not exist'] }]);
  });

  it('lists at most MAX_FIELD_ERRORS entries, however many elements a body refuses', async () => {
    const errors = await refusal({ inners: Array.from({ length: 5_000 }, () => ({ count: 9 })) }, InnerList);
    expect(errors).toHaveLength(MAX_FIELD_ERRORS);
    expect(errors?.[0]).toEqual({ field: 'inners.0.count', messages: ['count must not be greater than 5'] });
  });
});
