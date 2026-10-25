import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthSessionAuditService } from '../auth/auth-session-audit.service';
import { LocalAuthProvider } from '../auth/local-auth.provider';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';

/**
 * Password re-entry for the facility staff commands that add or change access
 * (P4b, S11, Q6): invite, change a role and remove a member. Health ID has no
 * staff two-step sign-in, so a stolen session alone must not be enough to add
 * accomplices. The password is checked exactly as a staff sign-in checks it
 * (LocalAuthProvider, with its lockout), against the session's own email, and
 * must belong to the session's own account. A failure counts towards the
 * sign-in lockout (five in 15 minutes lock sign-in for 15 minutes), as a
 * failed sign-in does. The password is never logged, hashed into a request
 * digest or audited.
 */
@Injectable()
export class StaffReauthenticationService {
  constructor(private readonly local: LocalAuthProvider, private readonly sessionAudit: AuthSessionAuditService) {}

  async confirm(actor: ActorContext, currentPassword: string, request: HidRequest): Promise<void> {
    const email = actor.email;
    if (!email) throw this.failed();
    let accountId: string | undefined;
    try {
      accountId = (await this.local.authenticate(email, currentPassword, 'staff', request.correlationId)).accountId;
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
      accountId = undefined;
    }
    if (!accountId || accountId !== actor.accountId) {
      await this.sessionAudit.recordLoginFailure(email, {
        correlationId: request.correlationId,
        actorSubject: actor.subject,
        sourceIp: request.ip,
        userAgent: request.header('user-agent'),
      });
      throw this.failed();
    }
  }

  private failed(): DomainProblem {
    return new DomainProblem(403, 'STAFF_REAUTHENTICATION_FAILED', 'That password isn\'t right');
  }
}
