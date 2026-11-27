import { type CanActivate, Injectable, type PipeTransform } from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment } from '../../config/environment';
import { NameOnlyCodes, codePairIncomplete, labTestCodeIncomplete } from '../shared/name-only-codes';
import {
  CreateLabRequestGroupDto,
  CreateLabRequestGroupNameOnlyDto,
  type CreateLabRequestGroupInput,
  type LabRequestGroupTestInput,
} from './lab-request-groups.dto';

/**
 * ORD-6 (0158; Ola's design note on hid-system#258, 7214746190): several
 * tests in one lab request. One ehr-api setting, LAB_REQUEST_GROUPS_ENABLED,
 * off by default. It stops new groups only:
 * - it gates POST .../lab-request-groups (503 LAB_REQUEST_GROUPS_UNAVAILABLE
 *   while off, before the body is read), and
 * - whether LabRequestsService.createInTransaction writes a group: while off
 *   it writes a null group (option (b), the clinical owner's call), so an
 *   order set's tests (ORD-8) are saved as separate requests, as today, and
 *   ORD-8 then writes no group audit row.
 * It never hides groups already written: with it off, requestGroupId in the
 * lab request answers and the list's ?requestGroupId= still work, and
 * lab-api (no setting) keeps showing groups on own work items, so the visit
 * list and the lab board agree. Switch it off (and ORDER_SETS_ENABLED off)
 * before an ehr-api image rollback or 0158's undo.
 */
export class LabRequestGroups {
  constructor(readonly enabled: boolean) {}

  static fromEnvironment(): LabRequestGroups {
    return new LabRequestGroups(getEnvironment().LAB_REQUEST_GROUPS_ENABLED);
  }
}

/** Off: no new group (the tests' and every direct caller's default). */
export const LAB_REQUEST_GROUPS_OFF = new LabRequestGroups(false);

/** The module provider: the setting as the environment sets it. */
export const LAB_REQUEST_GROUPS_PROVIDER = { provide: LabRequestGroups, useFactory: () => LabRequestGroups.fromEnvironment() };

/** The Idempotency-Key operation of the whole group call (EHR-C5's form: a whole-call row plus part rows). */
export const LAB_REQUEST_GROUP_OPERATION = 'lab-request-group.create';

/**
 * The Idempotency-Key operation of each test of the group route, from 1. The
 * names differ from the single create's (`lab-request.create`) and from
 * ORD-8's own, so a key never replays across routes (EHR-C5's rule).
 */
export const LAB_REQUEST_GROUP_PART = (index: number) => `lab-request-group.test.${index + 1}`;

/**
 * ORD-6: the group's sends to Lab end 25 s after the request reached
 * ehr-api. Each attempt may take 10 s (LabApiService) and a call with a key
 * makes 2, so without a deadline a send could end past nginx's 30 s, which
 * answers 503 UPSTREAM_UNAVAILABLE for a group already saved.
 */
export const LAB_REQUEST_GROUP_SEND_DEADLINE_MS = 25_000;

export function labRequestGroupsUnavailable(): DomainProblem {
  return new DomainProblem(503, 'LAB_REQUEST_GROUPS_UNAVAILABLE',
    'Several tests in one request are not available yet. Add each test on its own.');
}

/**
 * 503 LAB_REQUEST_GROUPS_UNAVAILABLE while LAB_REQUEST_GROUPS_ENABLED is off.
 * A guard, so it answers after the caller's permission (403 first) and before
 * the body is validated: a client that sees it falls back to one POST per
 * test, whatever its body.
 */
@Injectable()
export class LabRequestGroupsOnGuard implements CanActivate {
  constructor(private readonly groups: LabRequestGroups) {}

  canActivate(): boolean {
    if (!this.groups.enabled) throw labRequestGroupsUnavailable();
    return true;
  }
}

/**
 * The key a test is repeated by: coded tests by code system and code, and
 * every test by its name (trimmed, case and inner spaces ignored), so two
 * tests by name only with one name are repeated (0156).
 */
function repeatKeys(test: LabRequestGroupTestInput): string[] {
  const name = `name:${test.testDisplay.replace(/\s+/g, ' ').toLocaleLowerCase('en')}`;
  return test.testCodeSystem !== undefined && test.testCode !== undefined
    ? [JSON.stringify(['code', test.testCodeSystem, test.testCode]), name] : [name];
}

/** The index of the first test that repeats an earlier one, or -1. */
export function repeatedTest(tests: readonly LabRequestGroupTestInput[]): number {
  const seen = new Set<string>();
  for (const [index, test] of tests.entries()) {
    const keys = repeatKeys(test);
    if (keys.some((key) => seen.has(key))) return index;
    keys.forEach((key) => seen.add(key));
  }
  return -1;
}

/**
 * Validates a group body as CreateLabRequestBodyPipe validates a single
 * create (name-only-codes.ts): every test against today's class while
 * LAB_REQUEST_NAME_ONLY_ENABLED is off, or 0156's name-only class while on,
 * then the pair rule, 400 LAB_TEST_CODE_INCOMPLETE naming the first test with
 * one code only (`tests.<index>`, from 0). Then 400 LAB_REQUEST_TEST_REPEATED
 * for the first test that repeats an earlier one (repeatedTest). Any field
 * not declared, at the top or in a test, a requestGroupId included, is 400
 * VALIDATION_FAILED. The controller's body type is a union, so the global
 * pipe leaves the body to this one.
 */
@Injectable()
export class CreateLabRequestGroupBodyPipe implements PipeTransform<unknown, Promise<CreateLabRequestGroupInput>> {
  private readonly validation = createValidationPipe();

  constructor(private readonly nameOnly: NameOnlyCodes) {}

  async transform(value: unknown): Promise<CreateLabRequestGroupInput> {
    const input = await this.validation.transform(value, { type: 'body', data: undefined,
      metatype: this.nameOnly.labRequests ? CreateLabRequestGroupNameOnlyDto : CreateLabRequestGroupDto },
    ) as CreateLabRequestGroupInput;
    const tests: readonly LabRequestGroupTestInput[] = input.tests;
    const incomplete = tests.findIndex((test) => codePairIncomplete(test.testCodeSystem, test.testCode));
    if (incomplete >= 0) {
      throw labTestCodeIncomplete([{ field: `tests.${incomplete}`,
        messages: ['testCodeSystem and testCode must be supplied together'] }]);
    }
    const repeated = repeatedTest(tests);
    if (repeated >= 0) {
      throw new DomainProblem(400, 'LAB_REQUEST_TEST_REPEATED', 'This test is already in the request.',
        [{ field: `tests.${repeated}`, messages: ['This test is already in the request.'] }]);
    }
    return input;
  }
}
