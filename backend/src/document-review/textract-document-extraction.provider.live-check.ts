import 'dotenv/config';
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { TextractDocumentExtractionProvider } from './textract-document-extraction.provider';

/**
 * Manual, on-demand check that TextractDocumentExtractionProvider actually
 * reaches real AWS Textract, using whatever AWS credentials the
 * environment's default credential provider chain resolves (e.g.
 * ~/.aws/credentials) — never read or logged directly by this script. This
 * file does NOT end in `.spec.ts`, so Jest's testRegex (`.*\.spec\.ts$`)
 * never picks it up — normal `npm test` never touches real AWS. Run it
 * explicitly with `npm run textract:live-check`.
 *
 * AnalyzeExpense needs a real invoice-shaped document (single-page
 * PDF/JPEG/PNG) already sitting in AWS_S3_BUCKET to produce a meaningful
 * result — this script does not upload one itself. It lists the bucket for
 * the most recently uploaded object under the real `documents/` key prefix
 * (see S3DocumentStorageService.buildObjectKey) and reports clearly, rather
 * than failing silently, if none exists yet: upload a real document via
 * POST /document-review/upload first, then re-run this check.
 */
async function main() {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) {
    throw new Error(
      'AWS_S3_BUCKET and AWS_REGION must be set in .env to run this check',
    );
  }

  const s3 = new S3Client({ region });
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: 'documents/' }),
  );

  const candidate = (listed.Contents ?? [])
    .filter((object) => object.Key)
    .sort(
      (a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0),
    )[0];

  if (!candidate?.Key) {
    console.log(
      `Textract live check: no objects found under "documents/" in bucket "${bucket}". ` +
        'Upload a real invoice/order document via POST /document-review/upload ' +
        'first, then re-run this check — there is nothing real to extract yet.',
    );
    return;
  }

  const documentKey = candidate.Key;

  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: documentKey }),
  );
  const mimeType = head.ContentType;
  if (!mimeType) {
    throw new Error(
      `Object "${documentKey}" has no ContentType set on S3 - cannot determine mimeType for extraction`,
    );
  }

  console.log('Textract live check: using existing object');
  console.log('Key:', documentKey);
  console.log('MIME type:', mimeType);
  console.log('Last modified:', candidate.LastModified);

  const provider = new TextractDocumentExtractionProvider();
  const result = await provider.extract({ mimeType, documentKey });

  console.log('Textract live check succeeded for:', documentKey);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error('Textract live check failed:', error);
  process.exitCode = 1;
});
