import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { SendEmailDto } from './dto/send-email.dto';

@Injectable()
export class EmailService {
  async sendEmail(dto: SendEmailDto) {
    const credentialsPath = path.join(
      process.cwd(),
      'credentials',
      'google-oauth.json',
    );

    const tokenPath = path.join(
      process.cwd(),
      'credentials',
      'google-token.json',
    );

    const credentialsFile = await fs.readFile(
      credentialsPath,
      'utf8',
    );

    const tokenFile = await fs.readFile(
      tokenPath,
      'utf8',
    );

    const credentials = JSON.parse(credentialsFile);
    const tokens = JSON.parse(tokenFile);

    const { client_id, client_secret, redirect_uris } =
      credentials.installed;

    const oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0],
    );

    oauth2Client.setCredentials(tokens);

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