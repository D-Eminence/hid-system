import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import { WORKFORCE_MESSAGES } from './workforce-problems';

/**
 * The workforce routes' answers through the house problem filter, with the
 * contract's words for a field that fails validation: 400 VALIDATION_FAILED
 * "Check the highlighted fields." (docs/INTERFACE_CONTRACT.md ROS-1). The
 * fields stay in `errors`; every other answer is unchanged.
 */
@Catch()
export class WorkforceProblemFilter implements ExceptionFilter {
  private readonly problems = new ProblemDetailsFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof DomainProblem && exception.code === 'VALIDATION_FAILED'
      && exception.message !== WORKFORCE_MESSAGES.validation) {
      this.problems.catch(new DomainProblem(400, 'VALIDATION_FAILED', WORKFORCE_MESSAGES.validation, exception.errors),
        host);
      return;
    }
    this.problems.catch(exception, host);
  }
}
