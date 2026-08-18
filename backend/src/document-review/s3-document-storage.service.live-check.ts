import 'dotenv/config';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3DocumentStorageService } from './s3-document-storage.service';

/**
 * Manual, on-demand check that S3DocumentStorageService actually reaches the
 * real S3 bucket configured via AWS_REGION/AWS_S3_BUCKET in .env, using
 * whatever AWS credentials the environment's default credential provider
 * chain resolves (e.g. ~/.aws/credentials) — never read or logged directly
 * by this script. This file does NOT end in `.spec.ts`, so Jest's testRegex
 * (`.*\.spec\.ts$`) never picks it up — normal `npm test` never touches the
 * real bucket. Run it explicitly with `npm run s3:live-check`.
 *
 * Uploads one small temporary object, verifies it exists via a HEAD
 * request, then deletes it — the bucket is left exactly as it was found.
 */
async function main() {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) {
    throw new Error(
      'AWS_S3_BUCKET and AWS_REGION must be set in .env to run this check',
    );
  }

  const storage = new S3DocumentStorageService();
  const filename = `live-check-${Date.now()}.txt`;

  const uploaded = await storage.upload({
    filename,
    mimeType: 'text/plain',
    content: Buffer.from('S3 live-check temporary file'),
  });

  console.log('S3 live check: upload succeeded');
  console.log('URL:', uploaded.url);

  const key = new URL(uploaded.url).pathname.replace(/^\//, '');
  const client = new S3Client({ region });

  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    console.log('S3 live check: object confirmed to exist in bucket');
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    console.log('S3 live check: temporary object cleaned up');
  }
}

main().catch((error: unknown) => {
  console.error('S3 live check failed:', error);
  process.exitCode = 1;
});
