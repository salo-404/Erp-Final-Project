import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DocumentReviewStatus,
  InventoryTransactionType,
  PendingDocumentReview,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  InventoryTransactionsService,
  TransactionItemInput,
} from '../inventory-transactions/inventory-transactions.service';

/**
 * File-type/size validation happens here regardless of which storage backend
 * is behind DocumentStorageProvider — "PDF, Word (.doc/.docx), JPG, JPEG, PNG"
 * per the task requirements, expressed as the MIME types a browser/multer
 * upload would actually report for each.
 */
export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
] as const;

export type AllowedDocumentMimeType =
  (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

/**
 * Not specified anywhere in the schema/docs — a reasonable, explicit default
 * for an invoice/document scan. Callers needing a different limit should
 * override at the controller/integration layer rather than this being
 * silently hard-coded deeper than here.
 */
export const MAX_DOCUMENT_SIZE_BYTES = 15 * 1024 * 1024;

export interface UploadDocumentInput {
  filename: string;
  mimeType: string;
  /**
   * The actual file bytes. Size is derived from `content.length`, not taken
   * as a separate caller-supplied field — trusting a client-reported size
   * would let validation be bypassed by lying about it.
   */
  content: Buffer;
}

export interface UploadedDocument {
  url: string;
}

/**
 * Port for the real object-storage backend (S3 in production). Kept as an
 * injected interface — like SuppliersHistoryProvider elsewhere in this
 * codebase — so this service never depends on a concrete AWS SDK client;
 * that wiring belongs to the integration layer, not here.
 */
export interface DocumentStorageProvider {
  upload(input: {
    filename: string;
    mimeType: string;
    content: Buffer;
  }): Promise<UploadedDocument>;
}

export interface ExtractedDocumentItem {
  product: string;
  quantity: number;
  price?: number;
}

/**
 * The AI/document-extraction layer's output for one uploaded document.
 * Everything here is provisional — none of it is trusted as confirmed until
 * a human reviewer approves it (see approve()).
 */
export interface ExtractedDocumentData {
  /** AI's best guess at whether this document represents an incoming or outgoing movement. */
  transactionType: InventoryTransactionType;
  partyName?: string;
  supplierName?: string;
  date?: Date;
  warehouseName?: string;
  deliveryCountry?: string;
  deliveryRegion?: string;
  deliveryAddress?: string;
  items: ExtractedDocumentItem[];
}

/** Port for the AI/document-extraction layer. Never called from anywhere but upload(). */
export interface DocumentExtractionProvider {
  extract(input: {
    mimeType: string;
    content: Buffer;
  }): Promise<ExtractedDocumentData>;
}

export interface NewInvoiceNotificationEvent {
  reviewId: number;
  documentUrl: string;
  transactionType: InventoryTransactionType;
  extractedSupplierName: string | null;
  extractedPartyName: string | null;
  createdAt: Date;
}

/**
 * Port for the notification/integration layer. DocumentReviewService only
 * raises the event with enough data to act on — it never sends an email or
 * calendar invite itself (that's explicitly out of scope here).
 */
export interface DocumentReviewNotifier {
  notifyNewInvoice(event: NewInvoiceNotificationEvent): Promise<void>;
}

/**
 * DI tokens for the three provider interfaces above — interfaces have no
 * runtime identity, so NestJS can't resolve them by type alone the way it
 * does for a concrete class. DocumentReviewModule does NOT bind any of
 * these (no S3/AI-extraction/notification vendor has been chosen or
 * implemented yet — see the module's own doc comment); they must be bound
 * once real implementations exist.
 */
export const DOCUMENT_STORAGE_PROVIDER = Symbol('DOCUMENT_STORAGE_PROVIDER');
export const DOCUMENT_EXTRACTION_PROVIDER = Symbol(
  'DOCUMENT_EXTRACTION_PROVIDER',
);
export const DOCUMENT_REVIEW_NOTIFIER = Symbol('DOCUMENT_REVIEW_NOTIFIER');

export interface ProductMatchSuggestion {
  productId: number;
  name: string;
  /** 0-1 heuristic confidence; 1 = exact case-insensitive name match. Never auto-applied — a suggestion only. */
  score: number;
}

export interface SupplierMatchSuggestion {
  supplierId: number;
  name: string;
  /** 0-1 heuristic confidence; 1 = exact case-insensitive name match. Never auto-applied — a suggestion only. */
  score: number;
}

export interface ApproveDocumentReviewItemInput {
  productId: number;
  quantity: number;
  price?: number;
}

/**
 * The reviewer's CONFIRMED values — not the raw extractedX strings on the
 * review row. Matching (resolveProduct/resolveSupplier) only ever produces
 * suggestions; approve() requires the reviewer to have already turned those
 * suggestions into real IDs.
 */
export interface ApproveDocumentReviewInput {
  reviewedById: number;
  items: ApproveDocumentReviewItemInput[];
  expectedDate?: Date;
  /** Required when the review's transactionType is INCOMING. */
  supplierId?: number;
  /** Required when the review's transactionType is INCOMING. */
  destinationWarehouseId?: number;
  /** Required when the review's transactionType is OUTGOING. */
  sourceWarehouseId?: number;
  partyName?: string;
  deliveryCountry?: string;
  deliveryRegion?: string;
  deliveryAddress?: string;
}

export interface RejectDocumentReviewInput {
  reviewedById: number;
  rejectionReason: string;
}

type PendingDocumentReviewWithDetails = Prisma.PendingDocumentReviewGetPayload<{
  include: { transaction: { include: { items: true } }; reviewedBy: true };
}>;

@Injectable()
export class DocumentReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryTransactionsService: InventoryTransactionsService,
    @Inject(DOCUMENT_STORAGE_PROVIDER)
    private readonly storageProvider: DocumentStorageProvider,
    @Inject(DOCUMENT_EXTRACTION_PROVIDER)
    private readonly extractionProvider: DocumentExtractionProvider,
    @Inject(DOCUMENT_REVIEW_NOTIFIER)
    private readonly notifier: DocumentReviewNotifier,
  ) {}

  /**
   * Validates the file, stores it (S3 in production, via the injected
   * provider), runs it through the AI/document-extraction layer, and creates
   * a PENDING_REVIEW row holding only that provisional data — nothing here
   * is trusted until a human calls approve(). Emits a new-invoice
   * notification event once the review row exists; the integration layer
   * (not this service) decides what to do with it (e.g. send an email).
   */
  async upload(input: UploadDocumentInput): Promise<PendingDocumentReview> {
    this.validateFile(input);

    const uploaded = await this.storageProvider.upload({
      filename: input.filename,
      mimeType: input.mimeType,
      content: input.content,
    });

    const extracted = await this.extractionProvider.extract({
      mimeType: input.mimeType,
      content: input.content,
    });
    this.validateExtractedTransactionType(extracted.transactionType);

    const review = await this.prisma.pendingDocumentReview.create({
      data: {
        documentUrl: uploaded.url,
        transactionType: extracted.transactionType,
        extractedPartyName: extracted.partyName,
        extractedSupplierName: extracted.supplierName,
        extractedDate: extracted.date,
        extractedWarehouseName: extracted.warehouseName,
        extractedDeliveryCountry: extracted.deliveryCountry,
        extractedDeliveryRegion: extracted.deliveryRegion,
        extractedDeliveryAddress: extracted.deliveryAddress,
        extractedItems: extracted.items as unknown as Prisma.InputJsonValue,
        status: DocumentReviewStatus.PENDING_REVIEW,
      },
    });

    await this.notifier.notifyNewInvoice({
      reviewId: review.id,
      documentUrl: review.documentUrl,
      transactionType: review.transactionType,
      extractedSupplierName: review.extractedSupplierName,
      extractedPartyName: review.extractedPartyName,
      createdAt: review.createdAt,
    });

    return review;
  }

  /**
   * Approves a PENDING_REVIEW row using the reviewer's confirmed values,
   * creating the matching PENDING InventoryTransaction via
   * InventoryTransactionsService.createIncoming()/createOutgoing() — reused,
   * not duplicated, so stock is never touched here (those methods never
   * touch stock either; only complete() does). Claims the review row FIRST
   * via the same conditional-updateMany pattern used throughout
   * InventoryTransactionsService, preventing a double-approval race, all
   * inside one transaction so the claim rolls back if transaction creation
   * fails.
   */
  async approve(
    id: number,
    input: ApproveDocumentReviewInput,
    tx?: Prisma.TransactionClient,
  ): Promise<PendingDocumentReviewWithDetails> {
    if (tx) {
      return this.approveWithClient(tx, id, input);
    }
    return this.prisma.$transaction((innerTx) =>
      this.approveWithClient(innerTx, id, input),
    );
  }

  /**
   * Rejects a PENDING_REVIEW row, recording rejectionReason and who/when
   * reviewed it. Never creates a transaction and never touches stock.
   */
  async reject(
    id: number,
    input: RejectDocumentReviewInput,
    tx?: Prisma.TransactionClient,
  ): Promise<PendingDocumentReviewWithDetails> {
    if (!input.rejectionReason || !input.rejectionReason.trim()) {
      throw new BadRequestException('rejectionReason must not be empty');
    }
    if (tx) {
      return this.rejectWithClient(tx, id, input);
    }
    return this.prisma.$transaction((innerTx) =>
      this.rejectWithClient(innerTx, id, input),
    );
  }

  /** Read-only. Returns one review with its resulting transaction (if approved) and reviewer. */
  async getReview(
    id: number,
    tx?: Prisma.TransactionClient,
  ): Promise<PendingDocumentReviewWithDetails> {
    const client = tx ?? this.prisma;
    const review = await client.pendingDocumentReview.findUnique({
      where: { id },
      include: { transaction: { include: { items: true } }, reviewedBy: true },
    });
    if (!review) {
      throw new NotFoundException(`PendingDocumentReview ${id} not found`);
    }
    return review;
  }

  /** Read-only. Every row still awaiting a human decision, oldest first. */
  async getPendingReviews(
    tx?: Prisma.TransactionClient,
  ): Promise<PendingDocumentReview[]> {
    const client = tx ?? this.prisma;
    return client.pendingDocumentReview.findMany({
      where: { status: DocumentReviewStatus.PENDING_REVIEW },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Read-only suggestion search for a candidate Product by name — never
   * persists anything and is never invoked as part of approve(); the
   * reviewer is the one who turns a suggestion into a confirmed productId.
   * Matching is a simple case-insensitive substring heuristic (exact match
   * scores 1, partial match scores lower) — not a real fuzzy-matching
   * algorithm, since none exists in this codebase yet.
   *
   * Only suggests ACTIVE products — resolving a review to an inactive
   * product would let approve() create a brand-new transaction for a
   * discontinued product (approve() itself also rejects it via
   * InventoryTransactionsService, but filtering here means a reviewer never
   * sees it as a choice in the first place).
   */
  async resolveProduct(
    query: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProductMatchSuggestion[]> {
    if (!query || !query.trim()) {
      throw new BadRequestException('query must not be empty');
    }
    const client = tx ?? this.prisma;
    const candidates = await client.product.findMany({
      where: { name: { contains: query, mode: 'insensitive' }, isActive: true },
      take: 10,
    });

    return candidates
      .map((product) => ({
        productId: product.id,
        name: product.name,
        score: this.matchScore(query, product.name),
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Same suggestion-only contract as resolveProduct(), against Supplier —
   * only ACTIVE suppliers are suggested, for the same reason.
   */
  async resolveSupplier(
    query: string,
    tx?: Prisma.TransactionClient,
  ): Promise<SupplierMatchSuggestion[]> {
    if (!query || !query.trim()) {
      throw new BadRequestException('query must not be empty');
    }
    const client = tx ?? this.prisma;
    const candidates = await client.supplier.findMany({
      where: { name: { contains: query, mode: 'insensitive' }, isActive: true },
      take: 10,
    });

    return candidates
      .map((supplier) => ({
        supplierId: supplier.id,
        name: supplier.name,
        score: this.matchScore(query, supplier.name),
      }))
      .sort((a, b) => b.score - a.score);
  }

  private async approveWithClient(
    tx: Prisma.TransactionClient,
    id: number,
    input: ApproveDocumentReviewInput,
  ): Promise<PendingDocumentReviewWithDetails> {
    const claimed = await tx.pendingDocumentReview.updateMany({
      where: { id, status: DocumentReviewStatus.PENDING_REVIEW },
      data: {
        status: DocumentReviewStatus.APPROVED,
        reviewedById: input.reviewedById,
        reviewedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      await this.throwForNonPendingReview(tx, id, 'approve');
    }

    const review = await tx.pendingDocumentReview.findUniqueOrThrow({
      where: { id },
    });

    const items: TransactionItemInput[] = input.items;
    let transactionId: number;

    switch (review.transactionType) {
      case InventoryTransactionType.INCOMING: {
        if (
          input.supplierId === undefined ||
          input.destinationWarehouseId === undefined
        ) {
          throw new BadRequestException(
            'supplierId and destinationWarehouseId are required to approve an INCOMING review',
          );
        }
        const transaction =
          await this.inventoryTransactionsService.createIncoming(
            {
              supplierId: input.supplierId,
              destinationWarehouseId: input.destinationWarehouseId,
              expectedDate: input.expectedDate,
              documentUrl: review.documentUrl,
              items,
            },
            tx,
          );
        transactionId = transaction.id;
        break;
      }
      case InventoryTransactionType.OUTGOING: {
        if (input.sourceWarehouseId === undefined) {
          throw new BadRequestException(
            'sourceWarehouseId is required to approve an OUTGOING review',
          );
        }
        const transaction =
          await this.inventoryTransactionsService.createOutgoing(
            {
              sourceWarehouseId: input.sourceWarehouseId,
              partyName: input.partyName,
              deliveryCountry: input.deliveryCountry,
              deliveryRegion: input.deliveryRegion,
              deliveryAddress: input.deliveryAddress,
              expectedDate: input.expectedDate,
              documentUrl: review.documentUrl,
              items,
            },
            tx,
          );
        transactionId = transaction.id;
        break;
      }
      default:
        throw new BadRequestException(
          `Cannot approve a review with transactionType ${review.transactionType}`,
        );
    }

    await tx.pendingDocumentReview.update({
      where: { id },
      data: { transactionId },
    });

    return tx.pendingDocumentReview.findUniqueOrThrow({
      where: { id },
      include: { transaction: { include: { items: true } }, reviewedBy: true },
    });
  }

  private async rejectWithClient(
    tx: Prisma.TransactionClient,
    id: number,
    input: RejectDocumentReviewInput,
  ): Promise<PendingDocumentReviewWithDetails> {
    const claimed = await tx.pendingDocumentReview.updateMany({
      where: { id, status: DocumentReviewStatus.PENDING_REVIEW },
      data: {
        status: DocumentReviewStatus.REJECTED,
        rejectionReason: input.rejectionReason,
        reviewedById: input.reviewedById,
        reviewedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      await this.throwForNonPendingReview(tx, id, 'reject');
    }

    return tx.pendingDocumentReview.findUniqueOrThrow({
      where: { id },
      include: { transaction: { include: { items: true } }, reviewedBy: true },
    });
  }

  private validateFile(input: UploadDocumentInput): void {
    if (
      !ALLOWED_DOCUMENT_MIME_TYPES.includes(
        input.mimeType as AllowedDocumentMimeType,
      )
    ) {
      throw new BadRequestException(`Unsupported file type: ${input.mimeType}`);
    }
    if (input.content.length === 0) {
      throw new BadRequestException('Uploaded file is empty');
    }
    if (input.content.length > MAX_DOCUMENT_SIZE_BYTES) {
      throw new BadRequestException(
        `File exceeds the maximum allowed size of ${MAX_DOCUMENT_SIZE_BYTES} bytes`,
      );
    }
  }

  private validateExtractedTransactionType(
    type: InventoryTransactionType,
  ): void {
    if (
      type !== InventoryTransactionType.INCOMING &&
      type !== InventoryTransactionType.OUTGOING
    ) {
      throw new BadRequestException(
        `Document review only supports INCOMING or OUTGOING documents, got ${type}`,
      );
    }
  }

  private matchScore(query: string, candidateName: string): number {
    const normalizedQuery = query.trim().toLowerCase();
    const normalizedCandidate = candidateName.trim().toLowerCase();
    if (normalizedQuery === normalizedCandidate) {
      return 1;
    }
    if (
      normalizedCandidate.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedCandidate)
    ) {
      return 0.75;
    }
    return 0.5;
  }

  private async throwForNonPendingReview(
    tx: Prisma.TransactionClient,
    id: number,
    action: string,
  ): Promise<never> {
    const existing = await tx.pendingDocumentReview.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`PendingDocumentReview ${id} not found`);
    }
    throw new ConflictException(
      `PendingDocumentReview ${id} is not PENDING_REVIEW (status: ${existing.status}) — cannot ${action}`,
    );
  }
}
