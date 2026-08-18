/// <reference types="jest" />

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3DocumentStorageService } from './s3-document-storage.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockedGetSignedUrl = getSignedUrl as jest.MockedFunction<
  typeof getSignedUrl
>;

describe('S3DocumentStorageService', () => {
  const ORIGINAL_REGION = process.env.AWS_REGION;
  const ORIGINAL_BUCKET = process.env.AWS_S3_BUCKET;

  let sendSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance<void, unknown[]>;
  let consoleErrorSpy: jest.SpyInstance<void, unknown[]>;

  beforeEach(() => {
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_S3_BUCKET = 'test-bucket';
    sendSpy = jest.spyOn(S3Client.prototype, 'send');
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockedGetSignedUrl.mockReset();
  });

  afterEach(() => {
    process.env.AWS_REGION = ORIGINAL_REGION;
    process.env.AWS_S3_BUCKET = ORIGINAL_BUCKET;
    jest.restoreAllMocks();
  });

  it('throws when AWS_REGION is not configured', () => {
    delete process.env.AWS_REGION;

    expect(() => new S3DocumentStorageService()).toThrow(
      'AWS_REGION is not configured',
    );
  });

  it('throws when AWS_S3_BUCKET is not configured', () => {
    delete process.env.AWS_S3_BUCKET;

    expect(() => new S3DocumentStorageService()).toThrow(
      'AWS_S3_BUCKET is not configured',
    );
  });

  it('uploads successfully and returns the object URL and key, using the configured bucket and a key derived from the filename', async () => {
    sendSpy.mockResolvedValue({});

    const service = new S3DocumentStorageService();
    const result = await service.upload({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('fake pdf bytes'),
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const calls = sendSpy.mock.calls as unknown as [PutObjectCommand][];
    const command = calls[0][0];
    expect(command.input.Bucket).toBe('test-bucket');
    expect(command.input.Key).toMatch(
      /^documents\/[0-9a-f-]{36}-invoice\.pdf$/,
    );
    expect(command.input.ContentType).toBe('application/pdf');
    expect(command.input.Body).toEqual(Buffer.from('fake pdf bytes'));

    expect(result.key).toBe(command.input.Key);
    expect(result.url).toBe(
      `https://test-bucket.s3.amazonaws.com/${command.input.Key}`,
    );
  });

  it('sanitizes path separators and traversal segments out of the filename before using it in the key', async () => {
    sendSpy.mockResolvedValue({});

    const service = new S3DocumentStorageService();
    const result = await service.upload({
      filename: '../../etc/passwd',
      mimeType: 'application/pdf',
      content: Buffer.from('x'),
    });

    expect(result.url).not.toContain('..');
    expect(result.url).not.toContain('/etc/passwd');
    expect(result.key).not.toContain('..');
  });

  it('wraps an S3 upload failure in an InternalServerErrorException without leaking document content', async () => {
    sendSpy.mockRejectedValue(new Error('AccessDenied'));

    const service = new S3DocumentStorageService();
    const secretContent = Buffer.from('CONFIDENTIAL DOCUMENT BYTES');

    let caught: Error | undefined;
    try {
      await service.upload({
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        content: secretContent,
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain('Failed to upload document to S3');
    expect(caught?.message).toContain('AccessDenied');
    expect(caught?.message).not.toContain('CONFIDENTIAL DOCUMENT BYTES');
  });

  it('generates a presigned GET URL scoped to the configured bucket/key with a 300s expiry, without uploading anything', async () => {
    mockedGetSignedUrl.mockResolvedValue(
      'https://test-bucket.s3.amazonaws.com/documents/abc-invoice.pdf?X-Amz-Signature=fake',
    );

    const service = new S3DocumentStorageService();
    const url = await service.getPresignedUrl('documents/abc-invoice.pdf');

    expect(sendSpy).not.toHaveBeenCalled();
    expect(url).toBe(
      'https://test-bucket.s3.amazonaws.com/documents/abc-invoice.pdf?X-Amz-Signature=fake',
    );
    expect(mockedGetSignedUrl).toHaveBeenCalledTimes(1);

    const [, command, options] = mockedGetSignedUrl.mock.calls[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toEqual({
      Bucket: 'test-bucket',
      Key: 'documents/abc-invoice.pdf',
    });
    expect(options).toEqual({ expiresIn: 300 });
  });

  it('wraps a presigned URL generation failure in an InternalServerErrorException', async () => {
    mockedGetSignedUrl.mockRejectedValue(new Error('SignatureError'));

    const service = new S3DocumentStorageService();

    await expect(
      service.getPresignedUrl('documents/abc-invoice.pdf'),
    ).rejects.toThrow(
      'Failed to generate a presigned URL for S3 object "documents/abc-invoice.pdf": SignatureError',
    );
  });

  it('never logs document content, presigned URLs, or AWS credentials on success or failure', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_TEST_FAKE_KEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-fake-secret';

    sendSpy.mockResolvedValueOnce({});
    const service = new S3DocumentStorageService();
    await service.upload({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('SECRET BYTES'),
    });

    sendSpy.mockRejectedValueOnce(new Error('boom'));
    await service
      .upload({
        filename: 'invoice2.pdf',
        mimeType: 'application/pdf',
        content: Buffer.from('SECRET BYTES 2'),
      })
      .catch(() => undefined);

    mockedGetSignedUrl.mockResolvedValueOnce(
      'https://test-bucket.s3.amazonaws.com/documents/abc.pdf?X-Amz-Signature=super-secret-signature',
    );
    await service.getPresignedUrl('documents/abc.pdf');

    const allLoggedText = [
      ...consoleLogSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ]
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');

    expect(allLoggedText).not.toContain('SECRET BYTES');
    expect(allLoggedText).not.toContain('AKIA_TEST_FAKE_KEY');
    expect(allLoggedText).not.toContain('test-fake-secret');
    expect(allLoggedText).not.toContain('super-secret-signature');

    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });
});
