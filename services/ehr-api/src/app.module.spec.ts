import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from './app.module';

describe('EHR active composition after service cutovers', () => {
  it('does not register extracted Identity or OCR API modules', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as Array<{ name?: string }>;
    expect(imports.map((item) => item.name)).not.toEqual(expect.arrayContaining([
      'AuthModule', 'IdentityModule', 'ConsentModule', 'OcrModule',
    ]));
  });
});
