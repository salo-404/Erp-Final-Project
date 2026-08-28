import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { SendEmailDto } from './dto/send-email.dto';
import { getGoogleOAuth2Client } from '../google-auth';

// eslint-disable-next-line no-control-regex
const HAS_NON_ASCII = /[^\x00-\x7F]/;

/**
 * RFC 2047 encoded-word for a header field (Subject only needs this here -
 * To/Content-Type never carry user-authored text). Header fields are
 * US-ASCII by spec; a raw UTF-8 character (e.g. an em dash "—" a model-
 * composed subject used) left un-encoded gets reinterpreted by mail
 * clients as Latin-1/Windows-1252 and renders as mojibake ("Ã¢Â€Â”") -
 * confirmed live, not hypothetical. The message BODY doesn't need this -
 * it already declares charset="UTF-8" explicitly and is transmitted as
 * real UTF-8 bytes.
 */
export function encodeHeaderValue(value: string): string {
  if (!HAS_NON_ASCII.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

@Injectable()
export class EmailService {
  async sendEmail(dto: SendEmailDto) {
    const oauth2Client = getGoogleOAuth2Client();

    const gmail = google.gmail({
      version: 'v1',
      auth: oauth2Client,
    });

    const email = [
      `To: ${dto.to}`,
      `Subject: ${encodeHeaderValue(dto.subject)}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      dto.body,
    ].join('\r\n');

    const encodedEmail = Buffer.from(email)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail,
      },
    });

    return {
      success: true,
      messageId: response.data.id,
    };
  }
}