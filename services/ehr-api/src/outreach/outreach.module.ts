import { Module } from '@nestjs/common';

/**
 * Synchronous Outreach control boundary. Provider delivery remains a separate
 * worker concern; this module must never own a shadow patient directory.
 */
@Module({})
export class OutreachModule {}
