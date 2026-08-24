import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
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
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_SIZE_BYTES,
  type AllowedDocumentMimeType,
} from './document-validation.constants';

// Re-exported for backward compatibility — moved to
// document-validation.constants.ts (2026-08-22) so
// InventoryTransactionsService's attachDocument() can reuse the same rules
// without creating a circular dependency with this file (which already
// imports InventoryTransactionsService above).
export { ALLOWED_DOCUMENT_MIME_TYPES, MAX_DOCUMENT_SIZE_BYTES };
export type { AllowedDocumentMimeType };

/** resolveProduct()/resolveSupplier() drop anything scoring below this — noise, not a real suggestion. */
const MIN_SUGGESTION_SCORE = 0.2;
/** Cap on how many ranked suggestions resolveProduct()/resolveSupplier() return. */
const MAX_SUGGESTIONS = 10;
/** matchScore()'s ceiling when the query and candidate each name a different number (e.g. "22-inch" vs "24-inch"). */
const MAX_SCORE_WITH_CONFLICTING_NUMBERS = 0.4;

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
  /** Permanent, non-expiring reference to the stored object — the private S3 URL, persisted on the review row. Not directly fetchable without a presigned URL. */
  url: string;
  /** Storage key for the uploaded object — opaque to callers outside the storage provider, used only to ask for a presigned URL. */
  key: string;
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

  /**
   * A short-lived URL used only by the authenticated document-viewing
   * endpoint. Extraction reads the private S3 object directly by key.
   */
  getPresignedUrl(key: string): Promise<string>;

  /** Best-effort compensation for an object created by a failed upload flow. */
  delete(key: string): Promise<void>;
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

export function validateExtractedDocumentData(
  value: unknown,
): ExtractedDocumentData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(
      'Invalid extraction response: expected an object',
    );
  }
  const data = value as Record<string, unknown>;
  if (
    data.transactionType !== InventoryTransactionType.INCOMING &&
    data.transactionType !== InventoryTransactionType.OUTGOING
  ) {
    throw new BadRequestException(
      'Invalid extraction response: transactionType must be INCOMING or OUTGOING',
    );
  }
  if (!Array.isArray(data.items)) {
    throw new BadRequestException(
      'Invalid extraction response: items must be an array',
    );
  }

  const items = data.items.map((value, index): ExtractedDocumentItem => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(
        `Invalid extraction response: item ${index} must be an object`,
      );
    }
    const item = value as Record<string, unknown>;
    if (typeof item.product !== 'string' || !item.product.trim()) {
      throw new BadRequestException(
        `Invalid extraction response: item ${index} product must be a non-empty string`,
      );
    }
    if (
      typeof item.quantity !== 'number' ||
      !Number.isFinite(item.quantity) ||
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0
    ) {
      throw new BadRequestException(
        `Invalid extraction response: item ${index} quantity must be a positive integer`,
      );
    }
    if (
      item.price !== undefined &&
      (typeof item.price !== 'number' ||
        !Number.isFinite(item.price) ||
        item.price < 0)
    ) {
      throw new BadRequestException(
        `Invalid extraction response: item ${index} price must be a finite non-negative number`,
      );
    }
    return {
      product: item.product,
      quantity: item.quantity,
      ...(item.price === undefined ? {} : { price: item.price }),
    };
  });

  const optionalString = (field: string): string | undefined => {
    const fieldValue = data[field];
    if (fieldValue !== undefined && typeof fieldValue !== 'string') {
      throw new BadRequestException(
        `Invalid extraction response: ${field} must be a string`,
      );
    }
    return fieldValue as string | undefined;
  };
  let date: Date | undefined;
  if (data.date !== undefined) {
    if (!(typeof data.date === 'string' || data.date instanceof Date)) {
      throw new BadRequestException(
        'Invalid extraction response: date must be an ISO date string',
      );
    }
    date = data.date instanceof Date ? data.date : new Date(data.date);
    if (!Number.isFinite(date.getTime())) {
      throw new BadRequestException(
        'Invalid extraction response: date must be a valid date',
      );
    }
  }

  return {
    transactionType: data.transactionType,
    partyName: optionalString('partyName'),
    supplierName: optionalString('supplierName'),
    date,
    warehouseName: optionalString('warehouseName'),
    deliveryCountry: optionalString('deliveryCountry'),
    deliveryRegion: optionalString('deliveryRegion'),
    deliveryAddress: optionalString('deliveryAddress'),
    items,
  };
}

/**
 * Port for the extraction layer. upload() passes the already-private S3
 * object key, never raw bytes, a presigned URL, or a caller-supplied type.
 */
export interface DocumentExtractionProvider {
  extract(input: {
    mimeType: string;
    documentKey: string;
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
 * runtime identity, so DocumentReviewModule binds their implementations by
 * these tokens.
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
  private readonly logger = new Logger(DocumentReviewService.name);

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
   * provider), then runs Textract AnalyzeExpense against the private S3
   * object by key. The raw Buffer is sent only to S3. Creates a
   * PENDING_REVIEW row holding only that provisional data — nothing here is
   * trusted until a human calls approve(). Emits a new-invoice notification
   * event once the review row exists; the integration layer (not this
   * service) decides what to do with it (e.g. send an email).
   */
  async upload(input: UploadDocumentInput): Promise<PendingDocumentReview> {
    this.validateFile(input);

    const uploaded = await this.storageProvider.upload({
      filename: input.filename,
      mimeType: input.mimeType,
      content: input.content,
    });

    let review: PendingDocumentReview;
    try {
      const extracted = validateExtractedDocumentData(
        await this.extractionProvider.extract({
          mimeType: input.mimeType,
          documentKey: uploaded.key,
        }),
      );

      review = await this.prisma.pendingDocumentReview.create({
        data: {
          documentUrl: uploaded.url,
          documentKey: uploaded.key,
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
    } catch (error) {
      try {
        await this.storageProvider.delete(uploaded.key);
      } catch {
        this.logger.error(
          'Failed to clean up a newly uploaded document after upload pipeline failure',
        );
      }
      throw error;
    }

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

  /**
   * Regenerates a fresh, short-lived presigned URL for an already-uploaded
   * document — the permanent reference stays documentKey (the S3 object
   * key); nothing about this call is ever persisted. Existing/Get flow:
   * review ID -> stored documentKey -> storageProvider.getPresignedUrl(key).
   */
  async getDocumentPresignedUrl(id: number): Promise<{ url: string }> {
    const review = await this.prisma.pendingDocumentReview.findUnique({
      where: { id },
      select: { documentKey: true },
    });
    if (!review) {
      throw new NotFoundException(`PendingDocumentReview ${id} not found`);
    }
    if (!review.documentKey) {
      throw new NotFoundException(
        `PendingDocumentReview ${id} has no stored S3 object key`,
      );
    }

    const url = await this.storageProvider.getPresignedUrl(review.documentKey);
    return { url };
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
   *
   * Scores EVERY active product (never pre-filtered by a SQL substring
   * match — that would silently exclude a real candidate whose name
   * doesn't literally contain the typed query as a substring, e.g. an
   * abbreviation or reordered words, before matchScore() ever got a
   * chance to judge it). The catalog is confirmed small (single digits to
   * low tens), so scoring every active row in memory is cheap. Results
   * below MIN_SUGGESTION_SCORE are dropped as noise, and only the best
   * MAX_SUGGESTIONS are returned.
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
      where: { isActive: true },
    });

    return candidates
      .map((product) => ({
        productId: product.id,
        name: product.name,
        score: this.matchScore(query, product.name),
      }))
      .filter((match) => match.score >= MIN_SUGGESTION_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS);
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
      where: { isActive: true },
    });

    return candidates
      .map((supplier) => ({
        supplierId: supplier.id,
        name: supplier.name,
        score: this.matchScore(query, supplier.name),
      }))
      .filter((match) => match.score >= MIN_SUGGESTION_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS);
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
              documentKey: review.documentKey ?? undefined,
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
              documentKey: review.documentKey ?? undefined,
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

  /**
   * Token-overlap similarity (Jaccard over whitespace/punctuation-split
   * words), with a substring bonus and — critically — a hard cap when the
   * query and candidate each contain a number and those numbers disagree
   * (e.g. "22-inch Monitor" vs "24-inch Monitor"). Plain word overlap
   * can't tell those apart — both share "inch"/"monitor" — but a
   * conflicting spec number is a strong, cheap signal that these are
   * different products, not a match with adjectives in common.
   */
  private matchScore(query: string, candidateName: string): number {
    const normalizedQuery = query.trim().toLowerCase();
    const normalizedCandidate = candidateName.trim().toLowerCase();
    if (normalizedQuery === normalizedCandidate) {
      return 1;
    }

    const queryTokens = this.tokenize(normalizedQuery);
    const candidateTokens = this.tokenize(normalizedCandidate);
    const tokenScore = this.jaccardScore(queryTokens, candidateTokens);
    const substringBonus =
      normalizedCandidate.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedCandidate)
        ? 0.25
        : 0;
    const score = Math.min(1, tokenScore + substringBonus);

    const queryNumbers = this.extractNumbers(normalizedQuery);
    const candidateNumbers = this.extractNumbers(normalizedCandidate);
    const hasConflictingNumbers =
      queryNumbers.length > 0 &&
      candidateNumbers.length > 0 &&
      !queryNumbers.some((n) => candidateNumbers.includes(n));

    return hasConflictingNumbers
      ? Math.min(score, MAX_SCORE_WITH_CONFLICTING_NUMBERS)
      : score;
  }

  private tokenize(text: string): Set<string> {
    return new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  }

  private extractNumbers(text: string): string[] {
    return text.match(/\d+(\.\d+)?/g) ?? [];
  }

  private jaccardScore(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) {
      return 0;
    }
    let shared = 0;
    for (const token of a) {
      if (b.has(token)) shared += 1;
    }
    const union = new Set([...a, ...b]).size;
    return shared / union;
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
