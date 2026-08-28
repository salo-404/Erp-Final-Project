import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs/promises';
import { authenticate } from '@google-cloud/local-auth';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
];

const CREDENTIALS_PATH = path.join(
  process.cwd(),
  'credentials',
  'google-oauth.json',
);

const TOKEN_PATH = path.join(process.cwd(), 'credentials', 'google-token.json');

async function authorize() {
  const auth = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  await fs.writeFile(TOKEN_PATH, JSON.stringify(auth.credentials, null, 2));

  console.log('Google authorization successful.');
  console.log('New token saved to credentials/google-token.json');
}

authorize().catch(console.error);
