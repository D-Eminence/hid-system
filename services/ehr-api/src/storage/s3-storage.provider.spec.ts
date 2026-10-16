import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import { resetEnvironmentForTests } from '../config/environment';
import { DisabledStorageProvider } from './disabled-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import { StoredObjectIntegrityError } from './storage.types';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_client: unknown, command: { input: unknown }, options: { expiresIn: number }) =>
    `https://signed.example.invalid/?expires=${options.expiresIn}&input=${encodeURIComponent(JSON.stringify(command.input))}`),
}));

const KMS_KEY = 'arn:aws:kms:eu-west-1:000000000000:key/00000000-0000-4000-8000-000000000001';
const SHA256 = 'a'.repeat(64);
const head = (changes: Record<string, unknown> = {}) => ({
  VersionId: 'object-version-1', ContentLength: 2048, ContentType: 'application/pdf',
  ChecksumSHA256: Buffer.from(SHA256, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KMS_KEY,
  Metadata: { 'declared-sha256': SHA256 }, ...changes,
});

// The patient download route checks the exact stored version (checksum, size,
// encryption) before it signs a URL, and signs an attachment that browsers
// and proxies must not keep. The staff download route is unchanged.
describe('S3 document storage: exact version inspection and attachment downloads', () => {
  const original = { ...process.env };
  let send: jest.SpyInstance;

  function provider(kms: string | undefined = KMS_KEY): S3StorageProvider {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost/hid',
      CORS_ORIGINS: 'http://127.0.0.1', STORAGE_MODE: 's3', S3_BUCKET: 'synthetic-bucket', S3_REGION: 'eu-west-1' });
    if (kms) process.env.S3_KMS_KEY_ID = kms; else delete process.env.S3_KMS_KEY_ID;
    resetEnvironmentForTests();
    return new S3StorageProvider();
  }

  beforeEach(() => { send = jest.spyOn(S3Client.prototype, 'send'); });
  afterEach(() => {
    send.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('inspects the exact version with its checksum and returns its metadata', async () => {
    const storage = provider();
    send.mockResolvedValue(head());
    await expect(storage.inspectVersion('synthetic/report.pdf', 'object-version-1')).resolves.toEqual({
      versionId: 'object-version-1', sizeBytes: 2048, mediaType: 'application/pdf', sha256Hex: SHA256 });
    const command = send.mock.calls[0]?.[0] as HeadObjectCommand;
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(command.input).toEqual({ Bucket: 'synthetic-bucket', Key: 'synthetic/report.pdf', VersionId: 'object-version-1',
      ChecksumMode: 'ENABLED' });
  });

  it.each([
    ['another version', { VersionId: 'object-version-2' }],
    ['no checksum', { ChecksumSHA256: undefined }],
    ['a checksum of the wrong length', { ChecksumSHA256: Buffer.from('short').toString('base64') }],
    ['no size', { ContentLength: undefined }],
    ['no KMS encryption', { ServerSideEncryption: 'AES256', SSEKMSKeyId: undefined }],
    ['another KMS key', { SSEKMSKeyId: 'arn:aws:kms:eu-west-1:000000000000:key/another' }],
  ])('refuses %s as an integrity failure', async (_label, changes) => {
    const storage = provider();
    send.mockResolvedValue(head(changes));
    await expect(storage.inspectVersion('synthetic/report.pdf', 'object-version-1'))
      .rejects.toBeInstanceOf(StoredObjectIntegrityError);
  });

  it('requires AES256 encryption when no KMS key is configured', async () => {
    const storage = provider(undefined);
    send.mockResolvedValue(head({ ServerSideEncryption: 'AES256', SSEKMSKeyId: undefined }));
    await expect(storage.inspectVersion('synthetic/report.pdf', 'object-version-1')).resolves.toMatchObject({
      versionId: 'object-version-1' });
    send.mockResolvedValue(head({ ServerSideEncryption: undefined, SSEKMSKeyId: undefined }));
    await expect(storage.inspectVersion('synthetic/report.pdf', 'object-version-1'))
      .rejects.toBeInstanceOf(StoredObjectIntegrityError);
  });

  it('passes an object-store failure through, so it is not taken for an integrity failure', async () => {
    const storage = provider();
    send.mockRejectedValue(Object.assign(new Error('synthetic outage'), { name: 'ServiceUnavailable' }));
    const failure = storage.inspectVersion('synthetic/report.pdf', 'object-version-1');
    await expect(failure).rejects.toThrow('synthetic outage');
    await expect(failure).rejects.not.toBeInstanceOf(StoredObjectIntegrityError);
  });

  it('signs a 60 s attachment download that browsers and proxies do not keep', async () => {
    const storage = provider();
    const download = await storage.createDownload('synthetic/report.pdf', 'object-version-1',
      { fileName: 'Lab report (Oct) "final".pdf', mediaType: 'application/pdf' });
    expect(download.expiresInSeconds).toBe(60);
    const url = new URL(download.url);
    expect(url.searchParams.get('expires')).toBe('60');
    expect(JSON.parse(url.searchParams.get('input') ?? '{}')).toEqual({ Bucket: 'synthetic-bucket',
      Key: 'synthetic/report.pdf', VersionId: 'object-version-1',
      ResponseContentDisposition: 'attachment; filename="Lab_report__Oct___final_.pdf"',
      ResponseContentType: 'application/pdf', ResponseCacheControl: 'private, no-store' });
  });

  it('keeps the staff download exactly as it was: no attachment parameters', async () => {
    const storage = provider();
    const download = await storage.createDownload('synthetic/report.pdf', 'object-version-1');
    expect(JSON.parse(new URL(download.url).searchParams.get('input') ?? '{}'))
      .toEqual({ Bucket: 'synthetic-bucket', Key: 'synthetic/report.pdf', VersionId: 'object-version-1' });
    expect(GetObjectCommand).toBeDefined();
  });

  it('names an attachment with no usable character "attachment"', async () => {
    const storage = provider();
    const download = await storage.createDownload('synthetic/report.pdf', 'object-version-1',
      { fileName: '', mediaType: 'application/pdf' });
    expect(JSON.parse(new URL(download.url).searchParams.get('input') ?? '{}').ResponseContentDisposition)
      .toBe('attachment; filename="attachment"');
  });

  it('refuses every inspection while storage is disabled', async () => {
    const disabled = new DisabledStorageProvider();
    expect(() => disabled.inspectVersion('synthetic/report.pdf', 'object-version-1'))
      .toThrow(ServiceUnavailableException);
  });
});
