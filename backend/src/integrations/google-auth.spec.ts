import { InternalServerErrorException } from '@nestjs/common';
import { getGoogleOAuth2Client } from './google-auth';

describe('getGoogleOAuth2Client', () => {
  const ORIGINAL_CREDENTIALS = process.env.GOOGLE_OAUTH_CREDENTIALS_JSON;
  const ORIGINAL_TOKEN = process.env.GOOGLE_TOKEN_JSON;

  afterEach(() => {
    process.env.GOOGLE_OAUTH_CREDENTIALS_JSON = ORIGINAL_CREDENTIALS;
    process.env.GOOGLE_TOKEN_JSON = ORIGINAL_TOKEN;
  });

  it('fails closed with a clear error when neither env var is set', () => {
    delete process.env.GOOGLE_OAUTH_CREDENTIALS_JSON;
    delete process.env.GOOGLE_TOKEN_JSON;

    expect(() => getGoogleOAuth2Client()).toThrow(InternalServerErrorException);
    expect(() => getGoogleOAuth2Client()).toThrow(/not configured/);
  });

  it('fails closed when only the credentials JSON is set', () => {
    process.env.GOOGLE_OAUTH_CREDENTIALS_JSON = JSON.stringify({
      installed: { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] },
    });
    delete process.env.GOOGLE_TOKEN_JSON;

    expect(() => getGoogleOAuth2Client()).toThrow(InternalServerErrorException);
  });

  it('fails closed when only the token JSON is set', () => {
    delete process.env.GOOGLE_OAUTH_CREDENTIALS_JSON;
    process.env.GOOGLE_TOKEN_JSON = JSON.stringify({ refresh_token: 'token' });

    expect(() => getGoogleOAuth2Client()).toThrow(InternalServerErrorException);
  });

  it('builds a real OAuth2 client from both env vars, with the token credentials applied', () => {
    process.env.GOOGLE_OAUTH_CREDENTIALS_JSON = JSON.stringify({
      installed: {
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
        redirect_uris: ['http://localhost'],
      },
    });
    process.env.GOOGLE_TOKEN_JSON = JSON.stringify({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      scope: 'https://www.googleapis.com/auth/gmail.send',
      token_type: 'Bearer',
      expiry_date: 1234567890,
    });

    const client = getGoogleOAuth2Client();

    expect(client._clientId).toBe('test-client-id');
    expect(client.credentials.refresh_token).toBe('test-refresh-token');
    expect(client.credentials.access_token).toBe('test-access-token');
  });
});
