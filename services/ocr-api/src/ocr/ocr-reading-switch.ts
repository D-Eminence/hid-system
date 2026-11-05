import { Injectable } from '@nestjs/common';
import { getEnvironment } from '../config/environment';

// Whether the OCR worker reads paper records with Claude, as this API can know it: OCR_AI_MODE set to the
// same value as the worker's (off by default). It decides only extraction reuse at job creation; the worker
// alone decides whether a page is actually read by AI (its OCR_AI_FACILITY_IDS off-switch is not mirrored,
// so a facility switched off there gets a fresh Textract run instead of a reuse, never a stale reuse).
@Injectable()
export class OcrReadingSwitch {
  readonly aiReadingOn: boolean = getEnvironment().OCR_AI_MODE === 'claude';
}
