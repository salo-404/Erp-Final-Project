import { InternalServerErrorException } from '@nestjs/common';
import { google } from 'googleapis';

/**
 * Shared OAuth2 client factory for CalendarService and EmailService - the
 * only two real consumers of Google APIs in this codebase. Reads the same
 * two JSON blobs a one-time local `google-oauth.json`/`google-token.json`
 * setup produces (see README), but from environment variables instead of
 * local files, so a deployed container (no persistent local filesystem for
 * secrets) can use them - injected via Secrets Manager in production, the
 * same pattern as DATABASE_URL/JWT_SECRET.
 *
 * The refresh_token in GOOGLE_TOKEN_JSON is what actually matters long-term
 * - googleapis' OAuth2Client transparently uses it to mint a fresh access
 * token once the cached one expires, so this never needs re-provisioning
 * on a schedule.
 */
export function getGoogleOAuth2Client() {
  const credentialsJson = process.env.GOOGLE_OAUTH_CREDENTIALS_JSON;
  const tokenJson = process.env.GOOGLE_TOKEN_JSON;

  if (!credentialsJson || !tokenJson) {
    throw new InternalServerErrorException(
      'Google Calendar/Gmail is not configured on this backend (GOOGLE_OAUTH_CREDENTIALS_JSON/GOOGLE_TOKEN_JSON are not set).',
    );
  }

  const credentials = JSON.parse(credentialsJson);
  const tokens = JSON.parse(tokenJson);

  const { client_id, client_secret, redirect_uris } = credentials.installed;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0],
  );

  oauth2Client.setCredentials(tokens);

  return oauth2Client;
}
