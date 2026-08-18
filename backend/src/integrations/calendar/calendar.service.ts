import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { google } from 'googleapis';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { CreateCalendarEventDto } from './dto/create-calendar-event.dto';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async getCalendarEvents(startDate?: string, endDate?: string) {
    const parsedStartDate =
      startDate !== undefined ? new Date(startDate) : undefined;
    const parsedEndDate =
      endDate !== undefined ? new Date(endDate) : undefined;

    if (parsedStartDate && Number.isNaN(parsedStartDate.getTime())) {
      throw new BadRequestException('Invalid start date');
    }

    if (parsedEndDate && Number.isNaN(parsedEndDate.getTime())) {
      throw new BadRequestException('Invalid end date');
    }

    if (
      parsedStartDate &&
      parsedEndDate &&
      parsedEndDate <= parsedStartDate
    ) {
      throw new BadRequestException('End date must be after start date');
    }

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

    const credentialsFile = await fs.readFile(credentialsPath, 'utf8');
    const tokenFile = await fs.readFile(tokenPath, 'utf8');

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

    const calendar = google.calendar({
      version: 'v3',
      auth: oauth2Client,
    });

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: parsedStartDate
        ? parsedStartDate.toISOString()
        : new Date().toISOString(),
      ...(parsedEndDate && {
        timeMax: parsedEndDate.toISOString(),
      }),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    });

    return (response.data.items ?? []).map((event) => ({
      id: event.id,
      title: event.summary,
      description: event.description,
      startDate: event.start?.dateTime ?? event.start?.date,
      endDate: event.end?.dateTime ?? event.end?.date,
      eventLink: event.htmlLink,
    }));
  }

  async createCalendarEvent(dto: CreateCalendarEventDto) {
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

    const credentialsFile = await fs.readFile(credentialsPath, 'utf8');
    const tokenFile = await fs.readFile(tokenPath, 'utf8');

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

    const calendar = google.calendar({
      version: 'v3',
      auth: oauth2Client,
    });

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: dto.title,
        description: dto.description,
        start: {
          dateTime: dto.startDate,
        },
        end: {
          dateTime: dto.endDate,
        },
      },
    });

    return {
      success: true,
      eventId: response.data.id,
      eventLink: response.data.htmlLink,
    };
  }

  async createShipmentReminder(transactionId: number) {
    const transaction =
      await this.prisma.inventoryTransaction.findUnique({
        where: {
          id: transactionId,
        },
        include: {
          supplier: true,
          sourceWarehouse: true,
          destinationWarehouse: true,
        },
      });

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    if (!transaction.expectedDate) {
      throw new BadRequestException(
        'Transaction does not have an expected date',
      );
    }

    if (transaction.status !== 'PENDING') {
      throw new BadRequestException(
        'Shipment reminder can only be created for a pending transaction',
      );
    }

    let title = '';

    if (transaction.type === 'INCOMING') {
      title = 'Incoming Shipment';
    } else if (transaction.type === 'OUTGOING') {
      title = 'Outgoing Shipment';
    } else {
      title = 'Warehouse Transfer';
    }

    const descriptionParts = [
      `Transaction #${transaction.id}`,
      `Type: ${transaction.type}`,
    ];

    if (transaction.supplier) {
      descriptionParts.push(
        `Supplier: ${transaction.supplier.name}`,
      );
    }

    if (transaction.sourceWarehouse) {
      descriptionParts.push(
        `From: ${transaction.sourceWarehouse.name}`,
      );
    }

    if (transaction.destinationWarehouse) {
      descriptionParts.push(
        `To: ${transaction.destinationWarehouse.name}`,
      );
    }

    const startDate = new Date(transaction.expectedDate);

    const endDate = new Date(
      startDate.getTime() + 60 * 60 * 1000,
    );

    return this.createCalendarEvent({
      title,
      description: descriptionParts.join('\n'),
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    });
  }
}
