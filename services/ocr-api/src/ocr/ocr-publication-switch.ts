import { Injectable } from '@nestjs/common';
import { getEnvironment } from '../config/environment';

// OCR publication writes validated OCR evidence into EHR, Lab and Pharmacy.
// It stays paused (503 OCR_PUBLICATION_PAUSED) until the owner sets
// OCR_PUBLICATION_ENABLED=true after a synthetic-patient check; patient
// confirmation, which writes nothing outside OCR, is not affected.
@Injectable()
export class OcrPublicationSwitch {
  readonly enabled: boolean = getEnvironment().OCR_PUBLICATION_ENABLED;
}
