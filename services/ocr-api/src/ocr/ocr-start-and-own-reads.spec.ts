import 'reflect-metadata';
import { ANY_PERMISSIONS, REQUIRED_PERMISSIONS } from '../common/decorators';
import { OcrController, OcrPublicationController } from './ocr.controller';

// Owner decisions of 18 November 2026, migration 0136: Q111 A, starting or
// retrying a reading needs ocr.job.start as well as ocr.job.write (doctors
// keep ocr.job.write to check readings and confirm their patient, and do not
// get ocr.job.start); Q112 A, the front desk's ocr.job.read-own follows a
// reading's status but never reads its text.
describe('OCR routes after 0136 (Q111 A, Q112 A)', () => {
  const required = (handler: object) => Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as unknown;
  const anyOf = (handler: object) => Reflect.getMetadata(ANY_PERMISSIONS, handler) as unknown;

  it('starting and retrying a reading need ocr.job.write and ocr.job.start', () => {
    expect(required(OcrController.prototype.create)).toEqual(['ocr.job.write', 'ocr.job.start']);
    expect(required(OcrController.prototype.retry)).toEqual(['ocr.job.write', 'ocr.job.start']);
    expect(anyOf(OcrController.prototype.create)).toBeUndefined();
    expect(anyOf(OcrController.prototype.retry)).toBeUndefined();
  });

  it('checking a reading and confirming its patient are unchanged (doctors keep them)', () => {
    expect(required(OcrController.prototype.validate)).toEqual(['ocr.validation.write']);
    expect(required(OcrController.prototype.validatePlural)).toEqual(['ocr.validation.write']);
    expect(required(OcrController.prototype.confirmPatient)).toEqual(['ocr.patient.confirm']);
    expect(required(OcrPublicationController.prototype.publish)).toEqual(['ocr.publication.write']);
  });

  it('a reading\'s status takes ocr.job.read or ocr.job.read-own', () => {
    for (const handler of [OcrController.prototype.get, OcrController.prototype.find]) {
      expect(required(handler)).toBeUndefined();
      expect(anyOf(handler)).toEqual(['ocr.job.read', 'ocr.job.read-own']);
    }
  });

  it('the text taken from a document still needs ocr.job.read: ocr.job.read-own is not enough', () => {
    for (const handler of [OcrController.prototype.extractions, OcrController.prototype.validations,
      OcrPublicationController.prototype.list]) {
      expect(required(handler)).toEqual(['ocr.job.read']);
      expect(anyOf(handler)).toBeUndefined();
    }
  });
});
