import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from './app.module';

describe('standalone OCR composition', () => {
  it('registers OCR in its own process and has no worker composition dependency', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as Array<{ name?: string }>;
    expect(imports.map((item) => item.name)).toContain('OcrModule');
    const source = readFileSync(resolve(__dirname, 'app.module.ts'), 'utf8');
    expect(source).not.toMatch(/ocr-worker|Textract|OCR_PROVIDER/);
  });

  it('contains no direct EHR-domain SQL reference', () => {
    const source = readFileSync(resolve(__dirname, 'ocr/ocr.service.ts'), 'utf8');
    expect(source).not.toMatch(/\b(?:from|join|insert\s+into|update|delete\s+from)\s+ehr\./i);
    expect(source).toMatch(/EhrApiService/);
  });
});
