import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DocumentScanEventDto } from './document-scan-event.dto';

const base = {
  documentId: '50000000-0000-4000-8000-000000000001',
  objectVersionId: 's3-version-0001',
  objectSha256Hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  scannerEngine: 'ClamAV',
  scannerVersion: '1.4.3',
  idempotencyKey: '01J5A2C3D4E5F6G7H8J9K0MNPQ',
};

describe('DocumentScanEventDto', () => {
  it('requires a supported detected media type before a clean result can make a document available', async () => {
    const missing = await validate(plainToInstance(DocumentScanEventDto, { ...base, eventType: 'clean' }));
    expect(missing.some((error) => error.property === 'detectedMediaType')).toBe(true);

    const unsupported = await validate(plainToInstance(DocumentScanEventDto, {
      ...base,
      eventType: 'clean',
      detectedMediaType: 'text/html',
    }));
    expect(unsupported.some((error) => error.property === 'detectedMediaType')).toBe(true);

    const accepted = await validate(plainToInstance(DocumentScanEventDto, {
      ...base,
      eventType: 'clean',
      detectedMediaType: 'application/pdf',
    }));
    expect(accepted).toHaveLength(0);
  });

  it('requires a machine-safe reason code for failed and rejected scans', async () => {
    const missing = await validate(plainToInstance(DocumentScanEventDto, { ...base, eventType: 'rejected' }));
    expect(missing.some((error) => error.property === 'reasonCode')).toBe(true);

    const unsafe = await validate(plainToInstance(DocumentScanEventDto, {
      ...base,
      eventType: 'failed',
      reasonCode: 'malware found!',
    }));
    expect(unsafe.some((error) => error.property === 'reasonCode')).toBe(true);
  });

  it('requires an exact immutable object version and SHA-256 binding', async () => {
    const missingVersion = await validate(plainToInstance(DocumentScanEventDto, {
      ...base,
      objectVersionId: undefined,
      eventType: 'scan_started',
    }));
    expect(missingVersion.some((error) => error.property === 'objectVersionId')).toBe(true);

    const invalidHash = await validate(plainToInstance(DocumentScanEventDto, {
      ...base,
      objectSha256Hex: 'A'.repeat(64),
      eventType: 'scan_started',
    }));
    expect(invalidHash.some((error) => error.property === 'objectSha256Hex')).toBe(true);
  });
});
