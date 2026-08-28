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

/** The fuzzy fallback (buildFuzzyMatchResult()) drops anything scoring below this — noise, not a real suggestion. */
const MIN_SUGGESTION_SCORE = 0.2;
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

/**
 * A single real candidate the Document agent (or the fuzzy fallback,
 * reshaped into this same contract) considered — never a fabricated id.
 * confidence is 0-1 either way: the Document agent's own real confidence,
 * or the fuzzy matcher's real matchScore() value when falling back.
 * reason is always a real, specific sentence — the Document agent's own
 * reasoning, or a fixed, honest fallback sentence naming the fuzzy
 * matcher explicitly (never a fabricated reason pretending to be the AI's).
 */
export interface DocumentMatchCandidate {
  id: number;
  name: string;
  confidence: number;
  reason: string;
}

/** Only ever populated when status is NO_MATCH for a PRODUCT — see resolveProduct(). */
export interface DocumentMatchRecommendation {
  normalizedName: string;
  category: string | null;
  description: string | null;
}

/**
 * The full, un-collapsed result of matching one extracted name against the
 * real catalog — what resolveProduct()/resolveSupplier() now return
 * end-to-end (never flattened back into a bare {id, name, score} array).
 * candidates holds at most 3 entries. recommendation is non-null only for
 * a product NO_MATCH result — never for a supplier, and never alongside a
 * non-empty candidates list.
 */
export interface DocumentMatchResult {
  status: 'RESOLVED' | 'UNRESOLVED' | 'NO_MATCH';
  candidates: DocumentMatchCandidate[];
  recommendation: DocumentMatchRecommendation | null;
}

/**
 * Port for the real Document agent's own LLM-driven product/supplier
 * matching call (ai-agent/agents/document_agent/matching_agent.py),
 * reached through the SAME AgentCore /invocations endpoint the chat UI
 * uses ("document_match" mode — see agentcore_entrypoint.py's invoke()
 * docstring) — NOT a bespoke HTTP route, and NOT a generic pending-review
 * chat agent. Implementations authenticate as the CURRENT authenticated
 * reviewer (their own Cognito access token and ERP user id, forwarded
 * from the request that called resolveProduct()/resolveSupplier() below —
 * the same identity/session-ownership model AgentCore already enforces for
 * chat), never a separate service credential.
 *
 * The AI service reasons over these exact real candidates — this
 * interface's job is only to hand it enough real data to reason well:
 * category/description for products (Product's own real fields), and any
 * other real metadata for suppliers. Kept as an injected interface, same
 * pattern as DocumentStorageProvider/DocumentExtractionProvider above, so
 * this service never hard-codes a concrete HTTP client.
 *
 * Implementations MUST throw on any failure (network error, timeout,
 * non-2xx, malformed response, or the AI service's own signal that the
 * Document agent's output failed its own invented-id/consistency
 * validation) rather than returning a degraded result — resolveProduct()/
 * resolveSupplier() catch that throw and fall back to the existing
 * Jaccard-token matcher (matchScore() below), so a semantic-match failure
 * is never fatal to producing suggestions, only ever a fallback trigger.
 * Never invents an id — every DocumentMatchCandidate.id must trace back to
 * one of the real candidates the caller passed in. Enforced twice: once on
 * the AI side (matching_agent.py's _validate_verdict()) and independently
 * again by resolveProduct()/resolveSupplier() below against their own
 * candidate set before a result ever reaches a human reviewer.
 */
export interface DocumentSemanticMatchProvider {
  matchProduct(
    humanBearerToken: string,
    erpUserId: number,
    query: string,
    candidates: {
      id: number;
      name: string;
      category: string | null;
      description: string | null;
    }[],
  ): Promise<DocumentMatchResult>;
  matchSupplier(
    humanBearerToken: string,
    erpUserId: number,
    query: string,
    candidates: {
      id: number;
      name: string;
      email?: string | null;
      leadTimeDays?: number | null;
    }[],
  ): Promise<DocumentMatchResult>;
}

export const DOCUMENT_SEMANTIC_MATCH_PROVIDER = Symbol(
  'DOCUMENT_SEMANTIC_MATCH_PROVIDER',
);

/**
 * A brand-new product to create ATOMICALLY as part of this approval — never
 * created ahead of time (see ApproveDocumentReviewItemInput's own
 * docstring). category is grounded in the reviewer's own choice (often
 * pre-filled from the Document agent's category hint — see
 * DocumentReviewPage.tsx's categoryHintFromSearch() — but always editable
 * and never trusted blindly here either: re-validated against the real
 * category value the reviewer actually submitted, nothing invented).
 */
export interface NewProductDefinition {
  name: string;
  category?: string | null;
}

export interface ApproveDocumentReviewItemInput {
  /**
   * Set when this line resolves to an EXISTING product — mutually
   * exclusive with newProduct. At least one of the two must be set;
   * approve() rejects a line with neither (see resolveApprovalItems()).
   */
  productId?: number;
  /**
   * Set when this line defines a brand-new product instead — ONLY valid
   * for an INCOMING review (an OUTGOING/TRANSFER line can never define
   * one: shipping something that was never in the catalog makes no sense,
   * and resolveProduct() itself has no "create" path there — see
   * ResolveSearchInput's noMatchAlert). Never created until approve()
   * actually runs, inside the SAME transaction as the rest of the
   * approval — a duplicate name or any other failure elsewhere in the
   * batch rolls the new product back too, exactly like everything else
   * approve() does.
   */
  newProduct?: NewProductDefinition;
  quantity: number;
  price?: number;
}

/**
 * The reviewer's CONFIRMED values — not the raw extractedX strings on the
 * review row. Matching (resolveProduct/resolveSupplier) only ever produces
 * suggestions; approve() requires the reviewer to have already turned those
 * suggestions into real IDs, or — for a genuinely new INCOMING product —
 * a real newProduct definition (see ApproveDocumentReviewItemInput above).
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
    @Inject(DOCUMENT_SEMANTIC_MATCH_PROVIDER)
    private readonly semanticMatchProvider: DocumentSemanticMatchProvider,
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
   * Tries the AI layer's real semantic (meaning + wording) matcher first
   * (trySemanticProductMatch() — see DocumentSemanticMatchProvider's own
   * docstring above), and falls back to the original Jaccard-token
   * matchScore() below on ANY semantic-match failure (network error,
   * timeout, misconfiguration) — this is the one and only fallback
   * trigger; a successful-but-empty semantic result is NOT a failure and
   * is returned as-is (an honest "nothing plausible found", the same
   * answer the fuzzy matcher itself would give in that case).
   *
   * Scores EVERY active product (never pre-filtered by a SQL substring
   * match — that would silently exclude a real candidate whose name
   * doesn't literally contain the typed query as a substring, e.g. an
   * abbreviation or reordered words, before either matcher ever got a
   * chance to judge it). The catalog is confirmed small (single digits to
   * low tens), so scoring every active row in memory/one semantic-match
   * call is cheap. The fuzzy fallback path drops results below
   * MIN_SUGGESTION_SCORE as noise and returns only the best 3.
   *
   * Only suggests ACTIVE products — resolving a review to an inactive
   * product would let approve() create a brand-new transaction for a
   * discontinued product (approve() itself also rejects it via
   * InventoryTransactionsService, but filtering here means a reviewer never
   * sees it as a choice in the first place).
   */
  async resolveProduct(
    humanBearerToken: string,
    erpUserId: number,
    query: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DocumentMatchResult> {
    if (!query || !query.trim()) {
      throw new BadRequestException('query must not be empty');
    }
    const client = tx ?? this.prisma;
    const candidates = await client.product.findMany({
      where: { isActive: true },
    });

    const semanticResult = await this.trySemanticProductMatch(
      humanBearerToken,
      erpUserId,
      query,
      candidates,
    );
    if (semanticResult !== null) {
      return semanticResult;
    }

    return this.buildFuzzyMatchResult(
      query,
      candidates.map((product) => ({ id: product.id, name: product.name })),
      { isProduct: true },
    );
  }

  /**
   * Same suggestion-only contract as resolveProduct(), against Supplier —
   * only ACTIVE suppliers are suggested, for the same reason, and the same
   * semantic-first/fuzzy-fallback shape (trySemanticSupplierMatch()).
   */
  async resolveSupplier(
    humanBearerToken: string,
    erpUserId: number,
    query: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DocumentMatchResult> {
    if (!query || !query.trim()) {
      throw new BadRequestException('query must not be empty');
    }
    const client = tx ?? this.prisma;
    const candidates = await client.supplier.findMany({
      where: { isActive: true },
    });

    const semanticResult = await this.trySemanticSupplierMatch(
      humanBearerToken,
      erpUserId,
      query,
      candidates,
    );
    if (semanticResult !== null) {
      return semanticResult;
    }

    return this.buildFuzzyMatchResult(
      query,
      candidates.map((supplier) => ({ id: supplier.id, name: supplier.name })),
      { isProduct: false },
    );
  }

  /**
   * Calls DocumentSemanticMatchProvider.matchProduct(), independently
   * re-validates the result against this service's OWN candidate set
   * (validateDocumentMatchResult() — defense in depth; matching_agent.py
   * already validated on the AI side, but a result is never trusted
   * blindly twice in a row either), and returns it unchanged on success.
   * Returns null — never throws — on ANY provider failure OR a failed
   * re-validation, the caller's one and only fallback signal; logs a
   * warning server-side so a persistently failing semantic matcher is
   * visible in the logs even though it's never fatal.
   */
  private async trySemanticProductMatch(
    humanBearerToken: string,
    erpUserId: number,
    query: string,
    candidates: {
      id: number;
      name: string;
      category: string | null;
      description: string | null;
    }[],
  ): Promise<DocumentMatchResult | null> {
    try {
      const result = await this.semanticMatchProvider.matchProduct(
        humanBearerToken,
        erpUserId,
        query,
        candidates.map(({ id, name, category, description }) => ({
          id,
          name,
          category,
          description,
        })),
      );
      this.validateDocumentMatchResult(result, candidates, {
        isProduct: true,
      });
      return result;
    } catch (error) {
      this.logger.warn(
        `Semantic product match failed for query "${query}" — falling back to the existing fuzzy matcher: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** Same contract as trySemanticProductMatch(), for suppliers. */
  private async trySemanticSupplierMatch(
    humanBearerToken: string,
    erpUserId: number,
    query: string,
    candidates: {
      id: number;
      name: string;
      email?: string | null;
      leadTimeDays?: number | null;
    }[],
  ): Promise<DocumentMatchResult | null> {
    try {
      const result = await this.semanticMatchProvider.matchSupplier(
        humanBearerToken,
        erpUserId,
        query,
        candidates.map(({ id, name, email, leadTimeDays }) => ({
          id,
          name,
          email,
          leadTimeDays,
        })),
      );
      this.validateDocumentMatchResult(result, candidates, {
        isProduct: false,
      });
      return result;
    } catch (error) {
      this.logger.warn(
        `Semantic supplier match failed for query "${query}" — falling back to the existing fuzzy matcher: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Independent re-validation of the AI service's response against the
   * EXACT candidate set this service itself supplied — never trusts the AI
   * response just because matching_agent.py already validated it on its
   * own side (see that module's _validate_verdict() for the equivalent
   * AI-side checks; this is defense in depth, not a duplicate of the same
   * trust boundary). Throws on the first violation found; the caller's
   * catch block treats that identically to a network failure — fall back
   * to the fuzzy matcher, never show unvalidated output to a reviewer.
   */
  private validateDocumentMatchResult(
    result: DocumentMatchResult,
    candidates: { id: number; name: string; category?: string | null }[],
    { isProduct }: { isProduct: boolean },
  ): void {
    if (!result || !Array.isArray(result.candidates) || !result.status) {
      throw new Error('Document match result was not in the expected shape');
    }
    if (!['RESOLVED', 'UNRESOLVED', 'NO_MATCH'].includes(result.status)) {
      throw new Error(`Document match result had an invalid status: ${result.status}`);
    }
    if (result.candidates.length > 3) {
      throw new Error(
        `Document match result had ${result.candidates.length} candidates, maximum is 3`,
      );
    }

    const candidatesById = new Map(candidates.map((c) => [c.id, c]));
    const seenIds = new Set<number>();
    for (const candidate of result.candidates) {
      const real = candidatesById.get(candidate.id);
      if (!real) {
        throw new Error(
          `Document match result referenced id ${candidate.id}, which was not in the supplied candidates`,
        );
      }
      if (real.name !== candidate.name) {
        throw new Error(
          `Document match result's name for id ${candidate.id} ("${candidate.name}") did not match the real supplied name ("${real.name}")`,
        );
      }
      if (seenIds.has(candidate.id)) {
        throw new Error(`Document match result had duplicate candidate id ${candidate.id}`);
      }
      seenIds.add(candidate.id);
      if (
        typeof candidate.confidence !== 'number' ||
        Number.isNaN(candidate.confidence) ||
        candidate.confidence < 0 ||
        candidate.confidence > 1
      ) {
        throw new Error(
          `Document match result's confidence for id ${candidate.id} was out of the valid 0-1 range: ${candidate.confidence}`,
        );
      }
      if (typeof candidate.reason !== 'string' || !candidate.reason.trim()) {
        throw new Error(
          `Document match result had an empty reason for candidate id ${candidate.id}`,
        );
      }
    }

    if (result.status === 'RESOLVED' && result.candidates.length !== 1) {
      throw new Error(
        `Document match result had status RESOLVED with ${result.candidates.length} candidates, expected exactly 1`,
      );
    }
    if (result.status === 'UNRESOLVED' && result.candidates.length === 0) {
      throw new Error('Document match result had status UNRESOLVED with no candidates');
    }
    if (result.status === 'NO_MATCH' && result.candidates.length > 0) {
      throw new Error('Document match result had status NO_MATCH with non-empty candidates');
    }

    if (isProduct && result.status === 'NO_MATCH' && !result.recommendation) {
      throw new Error(
        'Document match result had product NO_MATCH without a new-product recommendation',
      );
    }
    if (!isProduct && result.recommendation) {
      throw new Error(
        'Document match result had a recommendation for a supplier — suppliers never get one',
      );
    }
    if (result.status !== 'NO_MATCH' && result.recommendation) {
      throw new Error(
        `Document match result had a recommendation with status ${result.status}, only NO_MATCH may carry one`,
      );
    }

    if (result.recommendation) {
      if (
        typeof result.recommendation.normalizedName !== 'string' ||
        !result.recommendation.normalizedName.trim()
      ) {
        throw new Error(
          'Document match result had a product recommendation with an empty normalizedName',
        );
      }
      const realCategories = new Set(
        candidates.map((c) => c.category).filter((c): c is string => !!c),
      );
      if (
        result.recommendation.category !== null &&
        !realCategories.has(result.recommendation.category)
      ) {
        throw new Error(
          `Document match result recommended category "${result.recommendation.category}", which was not one of the real categories supplied`,
        );
      }
    }
  }

  /**
   * Fuzzy-matcher fallback, reshaped into the SAME DocumentMatchResult
   * contract the AI path returns — so callers (the reviewer UI, the AI
   * agent's own plain resolve_document_product()/resolve_document_supplier()
   * tools) work identically regardless of which matcher actually answered.
   * reason is always a fixed, honest sentence naming the fuzzy matcher —
   * never fabricated as if it were the Document agent's own reasoning.
   * status: RESOLVED only for a genuine unique case-insensitive exact name
   * match (matchScore()'s own `=== 1` fast path); UNRESOLVED whenever at
   * least one candidate clears the noise floor; NO_MATCH otherwise — with,
   * for a product, a minimal, honest recommendation (a cleaned-up name
   * only; category/description stay null, since the fuzzy matcher has no
   * real basis to guess either).
   */
  private buildFuzzyMatchResult(
    query: string,
    candidates: { id: number; name: string; category?: string | null }[],
    { isProduct }: { isProduct: boolean },
  ): DocumentMatchResult {
    const FUZZY_REASON = 'Wording-similarity match — AI-based matching was unavailable for this request.';
    const normalizedQuery = query.trim().toLowerCase();

    const scored = candidates
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        confidence: this.matchScore(query, candidate.name),
      }))
      .filter((match) => match.confidence >= MIN_SUGGESTION_SCORE)
      .sort((a, b) => b.confidence - a.confidence);

    const exactMatches = scored.filter(
      (match) => match.name.trim().toLowerCase() === normalizedQuery,
    );

    if (exactMatches.length === 1) {
      return {
        status: 'RESOLVED',
        candidates: [{ ...exactMatches[0], confidence: 1, reason: FUZZY_REASON }],
        recommendation: null,
      };
    }

    if (scored.length === 0) {
      return {
        status: 'NO_MATCH',
        candidates: [],
        recommendation: isProduct
          ? { normalizedName: query.trim(), category: null, description: null }
          : null,
      };
    }

    return {
      status: 'UNRESOLVED',
      candidates: scored
        .slice(0, 3)
        .map((match) => ({ ...match, reason: FUZZY_REASON })),
      recommendation: null,
    };
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

    const items: TransactionItemInput[] = await this.resolveApprovalItems(
      tx,
      input.items,
      review.transactionType,
    );
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

  /**
   * Turns each ApproveDocumentReviewItemInput into a real
   * TransactionItemInput — resolving an existing productId as-is, or
   * creating a brand-new Product row for a newProduct definition, INSIDE
   * this same transaction so InventoryTransactionsService's own validation
   * (or a later item in this same batch) rolling the whole approval back
   * rolls the new product(s) back too. Never called outside approveWithClient's
   * own transaction.
   *
   * Only an INCOMING review's lines may define a newProduct — an
   * OUTGOING/TRANSFER line without a productId is rejected outright
   * (there's no "create it" path for stock you're shipping out that was
   * never in the catalog). Rejects a name that exactly (case-insensitively)
   * matches an already-active product, or that's defined more than once
   * within this same approval batch — "exact" only, never a fuzzy check,
   * so a genuinely different but similarly-worded product is never blocked.
   */
  private async resolveApprovalItems(
    tx: Prisma.TransactionClient,
    items: ApproveDocumentReviewItemInput[],
    transactionType: InventoryTransactionType,
  ): Promise<TransactionItemInput[]> {
    const namesClaimedThisApproval = new Set<string>();
    const resolved: TransactionItemInput[] = [];

    for (const item of items) {
      if (item.productId !== undefined) {
        resolved.push({
          productId: item.productId,
          quantity: item.quantity,
          price: item.price,
        });
        continue;
      }

      if (transactionType !== InventoryTransactionType.INCOMING) {
        throw new BadRequestException(
          'Every line item must reference an existing product for a non-INCOMING review',
        );
      }
      if (!item.newProduct || !item.newProduct.name.trim()) {
        throw new BadRequestException(
          'Every line item must reference an existing product or define a new one',
        );
      }

      const name = item.newProduct.name.trim();
      const normalizedName = name.toLowerCase();
      if (namesClaimedThisApproval.has(normalizedName)) {
        throw new ConflictException(
          `"${name}" is defined as a new product on more than one line in this approval`,
        );
      }

      const existing = await tx.product.findFirst({
        where: { name: { equals: name, mode: 'insensitive' }, isActive: true },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException(`A product named "${name}" already exists`);
      }

      const category = item.newProduct.category?.trim();
      const created = await tx.product.create({
        data: { name, category: category || null, isActive: true },
      });
      namesClaimedThisApproval.add(normalizedName);
      resolved.push({
        productId: created.id,
        quantity: item.quantity,
        price: item.price,
      });
    }

    return resolved;
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
