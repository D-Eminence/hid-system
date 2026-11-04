import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { resetEnvironmentForTests } from '../config/environment';
import { S3StorageProvider } from './s3-storage.provider';

const s3Environment = {
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic:test@localhost/hid', CORS_ORIGINS: 'https://app.example',
  STORAGE_MODE: 's3', S3_BUCKET: 'hid-documents', S3_REGION: 'eu-west-1', S3_KMS_KEY_ID: 'kms-key',
  S3_ACCESS_KEY_ID: 'synthetic-test-access-key-id', S3_SECRET_ACCESS_KEY: 'synthetic-secret-never-a-real-credential',
};

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
      S3_ACCESS_KEY_ID: 'synthetic-test-access-key-id', S3_SECRET_ACCESS_KEY: 'synthetic-secret-never-a-real-credential',
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

describe('S3 document scanning reads and downloads (0105)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, s3Environment);
    resetEnvironmentForTests();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  const body = (bytes: Uint8Array) => ({ transformToByteArray: async () => bytes });

  it('reads the first 1 KB of exactly the bound version with a ranged GET', async () => {
    const send = jest.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({
      VersionId: 'version-1', Body: body(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d])),
    }) as never);
    await expect(new S3StorageProvider().readPrefix('clinical/objects/a', 'version-1', 1024)).resolves
      .toEqual(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]));
    const command = send.mock.calls[0]?.[0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: 'hid-documents', Key: 'clinical/objects/a', VersionId: 'version-1',
      Range: 'bytes=0-1023' });
  });

  it('never returns more than asked, and refuses an answer for another version', async () => {
    jest.spyOn(S3Client.prototype, 'send').mockImplementationOnce(async () => ({
      VersionId: 'version-1', Body: body(new Uint8Array(4096)),
    }) as never).mockImplementationOnce(async () => ({
      VersionId: 'version-2', Body: body(new Uint8Array(8)),
    }) as never);
    const provider = new S3StorageProvider();
    await expect(provider.readPrefix('clinical/objects/a', 'version-1', 1024)).resolves.toHaveLength(1024);
    await expect(provider.readPrefix('clinical/objects/a', 'version-1', 1024)).rejects
      .toThrow('Stored object version is unavailable');
    await expect(provider.readPrefix('clinical/objects/a', 'version-1', 0)).rejects.toThrow(RangeError);
  });

  it('signs a download inline as the detected type, private and uncached', async () => {
    const { url } = await new S3StorageProvider().createDownload('clinical/objects/a', 'version-1', {
      fileName: 'Ward scan.jpg', mediaType: 'image/jpeg', disposition: 'inline',
    });
    const query = new URL(url).searchParams;
    expect(query.get('versionId')).toBe('version-1');
    expect(query.get('response-content-type')).toBe('image/jpeg');
    expect(query.get('response-content-disposition')).toBe('inline; filename="Ward_scan.jpg"');
    expect(query.get('response-cache-control')).toBe('private, no-store');
  });

  it('keeps attachment downloads as they were (imported attachments)', async () => {
    const { url } = await new S3StorageProvider().createDownload('migration-quarantine/a', 'version-1', {
      fileName: 'letter.pdf', mediaType: 'application/pdf',
    });
    expect(new URL(url).searchParams.get('response-content-disposition')).toBe('attachment; filename="letter.pdf"');
  });
});
