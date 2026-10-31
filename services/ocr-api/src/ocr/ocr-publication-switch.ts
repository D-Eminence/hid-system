import { Injectable } from '@nestjs/common';
import { getEnvironment } from '../config/environment';

// OCR publication writes validated OCR evidence into EHR, Lab and Pharmacy.
// The owner turned it on in production on 2026-10-31; OCR_PUBLICATION_ENABLED=false
// pauses it again (503 OCR_PUBLICATION_PAUSED). Patient confirmation, which writes
// nothing outside OCR, is not affected either way.
@Injectable()
export class OcrPublicationSwitch {
  readonly enabled: boolean = getEnvironment().OCR_PUBLICATION_ENABLED;
}
