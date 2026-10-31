import { resetEnvironmentForTests } from '../config/environment';
import { S3StorageProvider } from './s3-storage.provider';

describe('S3 presigned document upload', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  // inspect() requires the object's SHA-256 checksum and declared-sha256 metadata. The browser sends the required
  // headers, so both must be signed headers of the link, not query parameters S3 might not store on the object.
  it('signs the checksum and declared-sha256 metadata as headers the browser sends', async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic:test@localhost/hid', CORS_ORIGINS: 'https://app.example',
      STORAGE_MODE: 's3', S3_BUCKET: 'hid-documents', S3_REGION: 'eu-west-1', S3_KMS_KEY_ID: 'kms-key',
      S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', S3_SECRET_ACCESS_KEY: 'synthetic-secret-never-a-real-credential',
    });
    resetEnvironmentForTests();
    const sha256Hex = 'a'.repeat(64);
    const upload = await new S3StorageProvider().createUpload({
      key: 'clinical/example', mediaType: 'image/jpeg', sizeBytes: 1234, sha256Hex, expiresInSeconds: 300,
    });
    const url = new URL(upload.url);
    const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    expect(signed).toEqual(expect.arrayContaining(['x-amz-checksum-sha256', 'x-amz-meta-declared-sha256',
      'x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id']));
    const query = [...url.searchParams.keys()].map(name => name.toLowerCase());
    expect(query).not.toContain('x-amz-checksum-sha256');
    expect(query).not.toContain('x-amz-meta-declared-sha256');
    expect(upload.requiredHeaders['x-amz-checksum-sha256']).toBe(Buffer.from(sha256Hex, 'hex').toString('base64'));
    expect(upload.requiredHeaders['x-amz-meta-declared-sha256']).toBe(sha256Hex);
  });
});
