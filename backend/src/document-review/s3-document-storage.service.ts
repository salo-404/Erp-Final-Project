import { randomUUID } from 'node:crypto';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createAwsCredentialProvider } from '../common/aws-credential-provider';
import {
  DocumentStorageProvider,
  UploadedDocument,
} from './document-review.service';

/**
 * How long a presigned GET URL stays valid. Used only by the authenticated
 * viewing endpoint when a user needs temporary access, and kept short since
 * extraction reads the private S3 object directly by key.
 */
const PRESIGNED_URL_EXPIRY_SECONDS = 300;

/**
 * Real AWS S3 implementation of DocumentStorageProvider — this is the
 * only place in the codebase that touches the concrete AWS SDK client;
 * DocumentReviewService only ever sees the DocumentStorageProvider
 * interface (see DOCUMENT_STORAGE_PROVIDER binding in
 * document-review.module.ts).
 *
 * Authentication uses the S3Client's default credential provider chain
 * (environment variables, shared ~/.aws/credentials, EC2/ECS instance role,
 * etc.) — no access key, secret key, or session token is ever read from
 * config or hard-coded here. Only non-secret configuration
 * (AWS_REGION, AWS_S3_BUCKET) is read from the environment.
 */
@Injectable()
export class S3DocumentStorageService implements DocumentStorageProvider {
  private readonly client: S3Client;

  private readonly bucket: string;

  constructor() {
    const region = process.env.AWS_REGION;
    const bucket = process.env.AWS_S3_BUCKET;

    if (!region) {
      throw new InternalServerErrorException(
        'AWS_REGION is not configured — set it in .env to use S3DocumentStorageService',
      );
    }
    if (!bucket) {
      throw new InternalServerErrorException(
        'AWS_S3_BUCKET is not configured — set it in .env to use S3DocumentStorageService',
      );
    }

    this.bucket = bucket;
    this.client = new S3Client({
      region,
      credentials: createAwsCredentialProvider(),
    });
  }

  /**
   * Uploads the given document to the configured private bucket under a
   * random, collision-proof key (documents/<uuid>-<original filename>) and
   * returns its S3 URL and key. Never logs `content` (the file bytes) or
   * any AWS credential — only the derived key/bucket, which are not secret.
   */
  async upload(input: {
    filename: string;
    mimeType: string;
    content: Buffer;
  }): Promise<UploadedDocument> {
    const key = this.buildObjectKey(input.filename);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: input.content,
          ContentType: input.mimeType,
        }),
      );
    } catch (error) {
      throw new InternalServerErrorException(
        `Failed to upload document to S3: ${(error as Error).message}`,
      );
    }

    return {
      url: `https://${this.bucket}.s3.amazonaws.com/${key}`,
      key,
    };
  }

  /**
   * Generates a temporary presigned GET URL for an already-uploaded object
   * — the bucket itself remains private; this grants time-limited read
   * access to exactly one object, for exactly PRESIGNED_URL_EXPIRY_SECONDS.
   * Never logs the resulting URL (it embeds a short-lived access
   * signature) or any AWS credential.
   */
  async getPresignedUrl(key: string): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS },
      );
    } catch (error) {
      throw new InternalServerErrorException(
        `Failed to generate a presigned URL for S3 object "${key}": ${(error as Error).message}`,
      );
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /**
   * A random UUID prefix guarantees uniqueness regardless of how many times
   * the same filename is uploaded; the sanitized original filename is kept
   * in the key purely for human readability in the bucket, never trusted as
   * a safe path on its own (path separators/traversal segments are
   * stripped).
   */
  private buildObjectKey(filename: string): string {
    const safeFilename = filename.replace(/[/\\]/g, '_').replace(/\.\.+/g, '_');
    return `documents/${randomUUID()}-${safeFilename}`;
  }
}
