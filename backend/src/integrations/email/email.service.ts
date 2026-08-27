import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { SendEmailDto } from './dto/send-email.dto';
import { getGoogleOAuth2Client } from '../google-auth';

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
      `Subject: ${dto.subject}`,
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