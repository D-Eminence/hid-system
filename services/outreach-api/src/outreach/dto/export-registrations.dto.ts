import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** The formats an outreach registration list is exported in (the website builds the file). */
export const OUTREACH_EXPORT_FORMATS = ['csv', 'pdf', 'docx', 'xlsx'] as const;

/**
 * An export of outreach registrations, recorded for accountability: which
 * format and how many registrations, never their contents (the website builds
 * the file from the existing list and case reads).
 */
export class ExportRegistrationsDto {
  @IsIn(OUTREACH_EXPORT_FORMATS, { message: 'Choose CSV, PDF, Word or Excel' })
  format!: typeof OUTREACH_EXPORT_FORMATS[number];

  @IsInt() @Min(0) @Max(100000)
  count!: number;

  @IsOptional() @IsUUID('4')
  campaignId?: string;
}
