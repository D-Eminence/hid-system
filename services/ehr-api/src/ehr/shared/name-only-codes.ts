import { Injectable, type PipeTransform } from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment } from '../../config/environment';
import {
  CreateDiagnosisDto,
  CreateDiagnosisNameOnlyDto,
  CreateLabRequestDto,
  CreateLabRequestNameOnlyDto,
  type CreateDiagnosisInput,
  type CreateLabRequestInput,
} from './clinical.dto';

/**
 * Lab tests and diagnoses by name only (0156; ORD-7 F3 and ORD-9 of the
 * planned contract; Ola's design note on hid-system#258, 7192389223). Two
 * settings, both off by default:
 * - LAB_REQUEST_NAME_ONLY_ENABLED: a lab request may leave out its test code
 *   pair. It stays off until 0155's sensitive-test list build is live, since
 *   a test with no code is hidden from the patient's record chat by its name
 *   alone.
 * - DIAGNOSIS_NAME_ONLY_ENABLED: a diagnosis may leave out its code pair, and
 *   a diagnosis create answers `codeStatus`.
 * Off, the routes are exactly as before: a body is checked against today's
 * class, so a missing code is 400 VALIDATION_FAILED with today's messages,
 * and the answers carry no new key. On, the pair is both or neither (400
 * LAB_TEST_CODE_INCOMPLETE or DIAGNOSIS_CODE_INCOMPLETE), and a request or
 * diagnosis saved by name only answers null for both codes. The catalogue
 * status says which is on (labTestNameOnly, diagnosisNameOnly), so the website
 * offers "Use '<typed text>' as written" only to a backend that takes it.
 *
 * One way once used: the first time either setting goes on in production is
 * recorded (hid-system#258 and the next declaration). After it, lab-api stays
 * at or above 0156's image: an earlier lab-api refuses a null pair
 * (AcceptEhrOrderDto). Turning a setting off stops new name-only rows; rows
 * already saved keep their nulls.
 */
export class NameOnlyCodes {
  constructor(readonly labRequests: boolean, readonly diagnoses: boolean) {}

  static fromEnvironment(): NameOnlyCodes {
    const environment = getEnvironment();
    return new NameOnlyCodes(environment.LAB_REQUEST_NAME_ONLY_ENABLED, environment.DIAGNOSIS_NAME_ONLY_ENABLED);
  }
}

/** Both off: exactly today (the tests' and every direct caller's default). */
export const NAME_ONLY_CODES_OFF = new NameOnlyCodes(false, false);

/** The module provider: both settings as the environment sets them. */
export const NAME_ONLY_CODES_PROVIDER = { provide: NameOnlyCodes, useFactory: () => NameOnlyCodes.fromEnvironment() };

export function labTestCodeIncomplete(): DomainProblem {
  return new DomainProblem(400, 'LAB_TEST_CODE_INCOMPLETE', 'Test code and its code system must be supplied together.');
}

export function diagnosisCodeIncomplete(errors?: ConstructorParameters<typeof DomainProblem>[3]): DomainProblem {
  return new DomainProblem(400, 'DIAGNOSIS_CODE_INCOMPLETE', 'Diagnosis code and its code system must be supplied together.',
    errors);
}

/** Whether exactly one of a code pair was given (the checks have already refused null and empty text). */
export function codePairIncomplete(codeSystem: string | undefined, code: string | undefined): boolean {
  return (codeSystem === undefined) !== (code === undefined);
}

/**
 * Validates a lab request create body with the class the setting picks:
 * CreateLabRequestDto while off (today's checks and refusals, word for word),
 * CreateLabRequestNameOnlyDto while on, then the pair rule. The controller's
 * body type is a union, so the global pipe leaves the body to this one.
 */
@Injectable()
export class CreateLabRequestBodyPipe implements PipeTransform<unknown, Promise<CreateLabRequestInput>> {
  private readonly validation = createValidationPipe();

  constructor(private readonly nameOnly: NameOnlyCodes) {}

  async transform(value: unknown): Promise<CreateLabRequestInput> {
    const input = await this.validation.transform(value, { type: 'body', data: undefined,
      metatype: this.nameOnly.labRequests ? CreateLabRequestNameOnlyDto : CreateLabRequestDto }) as CreateLabRequestInput;
    if (codePairIncomplete(input.testCodeSystem, input.testCode)) throw labTestCodeIncomplete();
    return input;
  }
}

/** As CreateLabRequestBodyPipe, for a diagnosis create (DIAGNOSIS_NAME_ONLY_ENABLED). */
@Injectable()
export class CreateDiagnosisBodyPipe implements PipeTransform<unknown, Promise<CreateDiagnosisInput>> {
  private readonly validation = createValidationPipe();

  constructor(private readonly nameOnly: NameOnlyCodes) {}

  async transform(value: unknown): Promise<CreateDiagnosisInput> {
    const input = await this.validation.transform(value, { type: 'body', data: undefined,
      metatype: this.nameOnly.diagnoses ? CreateDiagnosisNameOnlyDto : CreateDiagnosisDto }) as CreateDiagnosisInput;
    if (codePairIncomplete(input.codeSystem, input.code)) throw diagnosisCodeIncomplete();
    return input;
  }
}
