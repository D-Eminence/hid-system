import { DomainProblem } from '../common/problem';
import { requireRequestContext, type DataAccessContext, type HidRequest, type PurposeOfUse } from '../common/request-context';

export function consentContext(
  request: HidRequest,
  allowedPurposes: readonly PurposeOfUse[],
): DataAccessContext {
  const purpose = request.header('x-purpose-of-use');
  if (!purpose || !allowedPurposes.includes(purpose as PurposeOfUse)) {
    throw new DomainProblem(
      400,
      'PURPOSE_OF_USE_REQUIRED',
      `X-Purpose-Of-Use must be ${allowedPurposes.join(' or ')} for this consent command`,
    );
  }
  return requireRequestContext(request, purpose);
}
