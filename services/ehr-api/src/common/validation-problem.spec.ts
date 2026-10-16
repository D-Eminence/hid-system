import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, Length, ValidateNested } from 'class-validator';
import { CreateVitalCorrectionDto } from '../ehr/shared/clinical.dto';
import { DomainProblem } from './problem';
import { globalValidationPipe, MAX_FIELD_ERRORS } from './validation-problem';

/** A list of coded items, for array element paths. */
class Item {
  @Length(2, 4)
  code!: string;
}

class ItemList {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Item)
  items!: Item[];
}

class BoundedItemList {
  @IsArray()
  @ArrayMaxSize(1)
  @ValidateNested({ each: true })
  @Type(() => Item)
  items!: Item[];
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
    const errors = await refusal({ expectedRowVersion: 1, changeReason: 'typo fix',
      replacementValues: { systolicMmhg: 999 } }, CreateVitalCorrectionDto);
    expect(errors).toEqual([
      { field: 'replacementValues.systolicMmhg', messages: ['systolicMmhg must not be greater than 350'] },
    ]);
    expect(JSON.stringify(errors)).not.toContain('999');
  });

  it('names an unknown nested property by its path', async () => {
    const errors = await refusal({ expectedRowVersion: 1, changeReason: 'typo fix',
      replacementValues: { systolicMmhg: 120, extra: 1 } }, CreateVitalCorrectionDto);
    expect(errors).toEqual([{ field: 'replacementValues.extra', messages: ['property extra should not exist'] }]);
  });

  it('names an array element by its index', async () => {
    const errors = await refusal({ items: [{ code: 'ab' }, { code: 'toolong' }] }, ItemList);
    expect(errors).toEqual([{ field: 'items.1.code', messages: ['code must be shorter than or equal to 4 characters'] }]);
  });

  it('keeps a parent that failed its own rule, with its children after it', async () => {
    const errors = await refusal({ items: [{ code: 'ab' }, { code: 'toolong' }] }, BoundedItemList);
    expect(errors).toEqual([
      { field: 'items', messages: ['items must contain no more than 1 elements'] },
      { field: 'items.1.code', messages: ['code must be shorter than or equal to 4 characters'] },
    ]);
  });

  it('leaves top-level entries as they were', async () => {
    const errors = await refusal({ expectedRowVersion: 0, changeReason: 'typo fix', replacementValues: 'x', foo: 1 },
      CreateVitalCorrectionDto);
    expect(errors).toEqual([
      { field: 'foo', messages: ['property foo should not exist'] },
      { field: 'replacementValues',
        messages: ['replacementValues must be an object', 'nested property replacementValues must be either object or array'] },
      { field: 'expectedRowVersion', messages: ['expectedRowVersion must not be less than 1'] },
    ]);
  });

  it('lists at most MAX_FIELD_ERRORS entries, however many elements a body refuses', async () => {
    // One entry per refused element would let a body within the size limit
    // (about 262,000 array elements) build an answer of tens of megabytes.
    const errors = await refusal({ expectedRowVersion: 1, changeReason: 'typo fix',
      replacementValues: Array.from({ length: 5_000 }, () => 1) }, CreateVitalCorrectionDto);
    expect(errors).toHaveLength(MAX_FIELD_ERRORS);
    expect(errors?.[0]).toEqual({ field: 'replacementValues', messages: ['replacementValues must be an object'] });
    const listed = await refusal({ items: Array.from({ length: 5_000 }, () => ({ code: 'x' })) }, ItemList);
    expect(listed).toHaveLength(MAX_FIELD_ERRORS);
    expect(listed?.[MAX_FIELD_ERRORS - 1]?.field).toBe(`items.${MAX_FIELD_ERRORS - 1}.code`);
  });
});
