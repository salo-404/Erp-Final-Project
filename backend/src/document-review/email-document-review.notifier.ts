import { Injectable, Logger } from '@nestjs/common';
import { UserRole } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../integrations/email/email.service';
import {
  DocumentReviewNotifier,
  NewInvoiceNotificationEvent,
} from './document-review.service';

/**
 * Simplest possible DocumentReviewNotifier: reuses Joseph's existing
 * EmailService (Gmail-backed) rather than building a new notification
 * system. Nothing here is persisted beyond the existing User table — no new
 * database, no new "assigned reviewer" concept, since the schema has no
 * field linking a review to a specific responsible user until it's
 * actually approved/rejected (reviewedById). The simplest reading of
 * "notify the responsible user" without a schema change is: notify every
 * ADMIN, since reviewing pending documents is an admin responsibility.
 *
 * A failure to email one (or all) admins must never break the upload flow
 * that triggered it — DocumentReviewService.upload() already awaits
 * notifyNewInvoice() after the review row is created, so this method never
 * throws; it logs and moves on.
 */
@Injectable()
export class EmailDocumentReviewNotifier implements DocumentReviewNotifier {
  private readonly logger = new Logger(EmailDocumentReviewNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async notifyNewInvoice(event: NewInvoiceNotificationEvent): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: UserRole.ADMIN },
      select: { email: true },
    });

    const party =
      event.extractedSupplierName ??
      event.extractedPartyName ??
      'unknown party';
    const subject = `New ${event.transactionType.toLowerCase()} invoice pending review (#${event.reviewId})`;
    const body = [
      'A new invoice has been uploaded and is awaiting review.',
      `Review ID: ${event.reviewId}`,
      `Type: ${event.transactionType}`,
      `Party: ${party}`,
      `Document: ${event.documentUrl}`,
      `Uploaded at: ${event.createdAt.toISOString()}`,
    ].join('\n');

    await Promise.all(
      admins.map(async (admin) => {
        try {
          await this.emailService.sendEmail({
            to: admin.email,
            subject,
            body,
          });
        } catch (error) {
          this.logger.error(
            `Failed to notify ${admin.email} about review ${event.reviewId}: ${(error as Error).message}`,
          );
        }
      }),
    );
  }
}
