/// <reference types="jest" />

import { EmailDocumentReviewNotifier } from './email-document-review.notifier';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../integrations/email/email.service';
import { NewInvoiceNotificationEvent } from './document-review.service';

function createMockPrisma(admins: { email: string }[]) {
  const findMany = jest.fn().mockResolvedValue(admins);
  const prisma = { user: { findMany } } as unknown as PrismaService;
  return { prisma, findMany };
}

function createMockEmailService() {
  const sendEmail = jest.fn();
  const service = { sendEmail } as unknown as EmailService;
  return { service, sendEmail };
}

const EVENT: NewInvoiceNotificationEvent = {
  reviewId: 1,
  documentUrl: 'https://s3.example.com/doc-1.pdf',
  transactionType: 'INCOMING',
  extractedSupplierName: 'Acme Supplies',
  extractedPartyName: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('EmailDocumentReviewNotifier', () => {
  it('emails every ADMIN user with details of the new review', async () => {
    const { prisma, findMany } = createMockPrisma([
      { email: 'admin1@example.com' },
      { email: 'admin2@example.com' },
    ]);
    const { service: emailService, sendEmail } = createMockEmailService();
    sendEmail.mockResolvedValue({ success: true, messageId: 'abc' });

    const notifier = new EmailDocumentReviewNotifier(prisma, emailService);
    await notifier.notifyNewInvoice(EVENT);

    expect(findMany).toHaveBeenCalledWith({
      where: { role: 'ADMIN' },
      select: { email: true },
    });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin1@example.com',
        subject: expect.stringContaining('#1') as string,
        body: expect.stringContaining('Acme Supplies') as string,
      }),
    );
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin2@example.com' }),
    );
    const bodies = sendEmail.mock.calls.map(
      ([message]: [{ body: string }]) => message.body,
    );
    expect(bodies.every((body) => !body.includes(EVENT.documentUrl))).toBe(true);
    expect(bodies.every((body) => body.includes('review #1'))).toBe(true);
  });

  it('does nothing (no error) when there are no ADMIN users', async () => {
    const { prisma } = createMockPrisma([]);
    const { service: emailService, sendEmail } = createMockEmailService();

    const notifier = new EmailDocumentReviewNotifier(prisma, emailService);

    await expect(notifier.notifyNewInvoice(EVENT)).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never fails the persisted upload when ADMIN recipient lookup fails', async () => {
    const { prisma, findMany } = createMockPrisma([]);
    findMany.mockRejectedValue(new Error('database unavailable'));
    const { service: emailService, sendEmail } = createMockEmailService();
    const notifier = new EmailDocumentReviewNotifier(prisma, emailService);

    await expect(notifier.notifyNewInvoice(EVENT)).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never throws when one admin email fails to send — logs and continues notifying the rest', async () => {
    const { prisma } = createMockPrisma([
      { email: 'admin1@example.com' },
      { email: 'admin2@example.com' },
    ]);
    const { service: emailService, sendEmail } = createMockEmailService();
    sendEmail.mockImplementation((dto: { to: string }) => {
      if (dto.to === 'admin1@example.com') {
        return Promise.reject(new Error('Gmail API quota exceeded'));
      }
      return Promise.resolve({ success: true, messageId: 'xyz' });
    });

    const notifier = new EmailDocumentReviewNotifier(prisma, emailService);

    await expect(notifier.notifyNewInvoice(EVENT)).resolves.toBeUndefined();
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('never throws when every admin email fails to send', async () => {
    const { prisma } = createMockPrisma([{ email: 'admin1@example.com' }]);
    const { service: emailService, sendEmail } = createMockEmailService();
    sendEmail.mockRejectedValue(new Error('SMTP down'));

    const notifier = new EmailDocumentReviewNotifier(prisma, emailService);

    await expect(notifier.notifyNewInvoice(EVENT)).resolves.toBeUndefined();
  });
});
