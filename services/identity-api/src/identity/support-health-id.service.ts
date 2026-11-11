import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * The support chat's server check (owner decision of 2026-10-31): which of the candidates support-api found in a
 * message are issued Health IDs, so it can replace each one before the text reaches Lex. The answer names only
 * candidates support-api already sent, never anything else about a patient. Logs counts only: no candidate, match or
 * message text is logged here.
 */
@Injectable()
export class SupportHealthIdService {
  private readonly logger = new Logger(SupportHealthIdService.name);

  constructor(private readonly database: DatabaseService) {}

  async matches(candidates: readonly string[]): Promise<{ matches: string[] }> {
    const asked = [...new Set(candidates)];
    const result = await this.database.query<{ health_id: string }>(
      'select health_id from identity.support_health_id_matches($1::text[])', [asked]);
    const known = new Set(asked);
    const matches = result.rows.map((row) => row.health_id);
    // The function answers candidates only; anything else means the database is not as 0109 made it.
    if (matches.some((match) => !known.has(match)) || new Set(matches).size !== matches.length) {
      throw new ServiceUnavailableException('The support Health ID check is unavailable');
    }
    this.logger.log({ message: 'Support Health ID check', candidates: asked.length, matches: matches.length });
    return { matches };
  }
}
