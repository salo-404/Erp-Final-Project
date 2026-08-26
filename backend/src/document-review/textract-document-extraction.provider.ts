import { Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  AnalyzeExpenseCommand,
  ExpenseDocument,
  ExpenseField,
  TextractClient,
} from '@aws-sdk/client-textract';
import { InventoryTransactionType } from '../../generated/prisma/client';
import { createAwsCredentialProvider } from '../common/aws-credential-provider';
import {
  DocumentExtractionProvider,
  ExtractedDocumentData,
  ExtractedDocumentItem,
  validateExtractedDocumentData,
} from './document-review.service';

const DEFAULT_TEXTRACT_TIMEOUT_MS = 30000;
const TRANSACTION_TYPE_LABEL = 'TRANSACTION TYPE';
const WAREHOUSE_LABELS = new Set([
  'WAREHOUSE',
  'SOURCE WAREHOUSE',
  'DESTINATION WAREHOUSE',
]);
const RECEIVER_GROUPS = [
  'RECEIVER_SHIP_TO',
  'RECEIVER_SOLD_TO',
  'RECEIVER_BILL_TO',
];

@Injectable()
export class TextractDocumentExtractionProvider implements DocumentExtractionProvider {
  private readonly bucket: string;
  private readonly timeoutMs: number;
  private readonly client: TextractClient;

  constructor() {
    const region = process.env.AWS_REGION?.trim();
    if (!region) {
      throw new InternalServerErrorException('AWS_REGION is not configured');
    }
    const bucket = process.env.AWS_S3_BUCKET?.trim();
    if (!bucket) {
      throw new InternalServerErrorException('AWS_S3_BUCKET is not configured');
    }

    this.bucket = bucket;
    const configuredTimeout = Number(process.env.TEXTRACT_TIMEOUT_MS);
    this.timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_TEXTRACT_TIMEOUT_MS;
    this.client = new TextractClient({
      region,
      credentials: createAwsCredentialProvider(),
    });
  }

  async extract(input: {
    mimeType: string;
    documentKey: string;
  }): Promise<ExtractedDocumentData> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let expenseDocuments: ExpenseDocument[] | undefined;

    try {
      const response = await this.client.send(
        new AnalyzeExpenseCommand({
          Document: {
            S3Object: {
              Bucket: this.bucket,
              Name: input.documentKey,
            },
          },
        }),
        { abortSignal: signal },
      );
      expenseDocuments = response.ExpenseDocuments;
    } catch (error) {
      const errorName = (error as Error | undefined)?.name;
      if (
        signal.aborted ||
        errorName === 'TimeoutError' ||
        errorName === 'AbortError'
      ) {
        throw new InternalServerErrorException(
          `Textract extraction timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new InternalServerErrorException('Textract extraction failed');
    }

    if (!expenseDocuments?.length) {
      throw new InternalServerErrorException(
        'Textract extraction returned no expense document',
      );
    }
    if (expenseDocuments.length !== 1) {
      throw new InternalServerErrorException(
        'Textract extraction returned multiple expense documents',
      );
    }

    return validateExtractedDocumentData(
      this.mapExpenseDocument(expenseDocuments[0]),
    );
  }

  private mapExpenseDocument(document: ExpenseDocument): ExtractedDocumentData {
    const summaryFields = document.SummaryFields ?? [];
    const transactionType = this.extractTransactionType(document);

    return {
      transactionType,
      supplierName:
        transactionType === InventoryTransactionType.INCOMING
          ? this.findSupplierName(summaryFields)
          : undefined,
      partyName:
        transactionType === InventoryTransactionType.OUTGOING
          ? this.findReceiverName(summaryFields)
          : undefined,
      date: this.findDate(summaryFields),
      warehouseName: this.findWarehouseName(summaryFields),
      deliveryAddress: this.findDeliveryAddress(summaryFields, transactionType),
      deliveryCountry: this.findReceiverField(summaryFields, ['COUNTRY']),
      deliveryRegion: this.findReceiverField(summaryFields, [
        'STATE',
        'REGION',
      ]),
      items: this.mapLineItems(document),
    };
  }

  private extractTransactionType(
    document: ExpenseDocument,
  ): InventoryTransactionType {
    const values = new Set<InventoryTransactionType>();
    let invalidExplicitMarker = false;

    for (const field of document.SummaryFields ?? []) {
      if (
        this.normalize(field.LabelDetection?.Text) !== TRANSACTION_TYPE_LABEL
      ) {
        continue;
      }
      const parsed = this.parseTransactionType(field.ValueDetection?.Text);
      if (parsed) values.add(parsed);
      else invalidExplicitMarker = true;
    }

    for (const block of document.Blocks ?? []) {
      if (block.BlockType !== 'LINE' || !block.Text) continue;
      const match = block.Text.match(/^\s*Transaction\s+Type\s*:\s*(.*?)\s*$/i);
      if (!match) continue;
      const parsed = this.parseTransactionType(match[1]);
      if (parsed) values.add(parsed);
      else invalidExplicitMarker = true;
    }

    if (invalidExplicitMarker) {
      throw new InternalServerErrorException(
        'Textract extraction found an invalid explicit Transaction Type marker',
      );
    }
    if (values.size === 0) {
      throw new InternalServerErrorException(
        'Textract extraction could not find an explicit Transaction Type marker',
      );
    }
    if (values.size > 1) {
      throw new InternalServerErrorException(
        'Textract extraction found conflicting Transaction Type markers',
      );
    }
    return values.values().next().value as InventoryTransactionType;
  }

  private parseTransactionType(
    text: string | undefined,
  ): InventoryTransactionType | undefined {
    switch (this.normalize(text)) {
      case 'INCOMING':
        return InventoryTransactionType.INCOMING;
      case 'OUTGOING':
        return InventoryTransactionType.OUTGOING;
      default:
        return undefined;
    }
  }

  private findSupplierName(fields: ExpenseField[]): string | undefined {
    return (
      this.findValueByType(fields, 'VENDOR_NAME') ??
      this.findGroupedValue(fields, ['NAME'], ['VENDOR_SUPPLIER'])
    );
  }

  private findReceiverName(fields: ExpenseField[]): string | undefined {
    return (
      this.findValueByType(fields, 'RECEIVER_NAME') ??
      this.findGroupedValue(fields, ['NAME'], RECEIVER_GROUPS)
    );
  }

  private findDate(fields: ExpenseField[]): Date | undefined {
    for (const type of ['INVOICE_RECEIPT_DATE', 'ORDER_DATE']) {
      for (const field of fields) {
        if (this.fieldType(field) !== type) continue;
        const value = this.fieldValue(field);
        if (!value) continue;
        const date = new Date(value);
        if (Number.isFinite(date.getTime())) return date;
      }
    }
    return undefined;
  }

  private findWarehouseName(fields: ExpenseField[]): string | undefined {
    const names = new Set<string>();
    for (const field of fields) {
      if (!WAREHOUSE_LABELS.has(this.normalize(field.LabelDetection?.Text))) {
        continue;
      }
      const value = this.fieldValue(field);
      if (value) names.add(value);
    }
    if (names.size > 1) {
      throw new InternalServerErrorException(
        'Textract extraction found conflicting Warehouse fields',
      );
    }
    return names.values().next().value;
  }

  private findReceiverField(
    fields: ExpenseField[],
    types: string[],
  ): string | undefined {
    return this.findGroupedValue(fields, types, RECEIVER_GROUPS);
  }

  private findDeliveryAddress(
    fields: ExpenseField[],
    transactionType: InventoryTransactionType,
  ): string | undefined {
    if (transactionType === InventoryTransactionType.OUTGOING) {
      return (
        this.findValueByType(fields, 'RECEIVER_ADDRESS') ??
        this.findGroupedValue(fields, ['ADDRESS_BLOCK'], RECEIVER_GROUPS) ??
        this.findGroupedValue(fields, ['ADDRESS'], RECEIVER_GROUPS)
      );
    }
    return this.findGroupedValue(fields, ['ADDRESS'], RECEIVER_GROUPS);
  }

  private findGroupedValue(
    fields: ExpenseField[],
    fieldTypes: string[],
    groupTypes: string[],
  ): string | undefined {
    for (const groupType of groupTypes) {
      const field = fields.find(
        (candidate) =>
          fieldTypes.includes(this.fieldType(candidate)) &&
          this.groupTypes(candidate).includes(groupType),
      );
      const value = field && this.fieldValue(field);
      if (value) return value;
    }
    return undefined;
  }

  private findValueByType(
    fields: ExpenseField[],
    type: string,
  ): string | undefined {
    const field = fields.find(
      (candidate) => this.fieldType(candidate) === type,
    );
    return field && this.fieldValue(field);
  }

  private mapLineItems(document: ExpenseDocument): ExtractedDocumentItem[] {
    const items: ExtractedDocumentItem[] = [];
    for (const group of document.LineItemGroups ?? []) {
      for (const lineItem of group.LineItems ?? []) {
        const fields = lineItem.LineItemExpenseFields ?? [];
        const product = this.findValueByType(fields, 'ITEM');
        const quantity = this.parseQuantity(
          this.findValueByType(fields, 'QUANTITY'),
        );
        if (!product || quantity === undefined) continue;

        const unitPriceField = fields.find(
          (field) => this.fieldType(field) === 'UNIT_PRICE',
        );
        let price: number | undefined;
        if (unitPriceField) {
          price = this.parsePrice(this.fieldValue(unitPriceField));
        } else {
          const totalPrice = this.parsePrice(
            this.findValueByType(fields, 'PRICE'),
          );
          if (totalPrice !== undefined) {
            const derivedUnitPrice = totalPrice / quantity;
            if (Number.isFinite(derivedUnitPrice) && derivedUnitPrice >= 0) {
              price = derivedUnitPrice;
            }
          }
        }

        items.push({
          product,
          quantity,
          ...(price === undefined ? {} : { price }),
        });
      }
    }
    return items;
  }

  private parseQuantity(text: string | undefined): number | undefined {
    if (!text) return undefined;
    const normalized = text.trim().replace(/,/g, '');
    if (!/^\d+(?:\.0+)?$/.test(normalized)) return undefined;
    const value = Number(normalized);
    return Number.isFinite(value) && Number.isInteger(value) && value > 0
      ? value
      : undefined;
  }

  private parsePrice(text: string | undefined): number | undefined {
    if (!text) return undefined;
    let normalized = text.trim().replace(/,/g, '');
    normalized = normalized
      .replace(/^(?:[A-Z]{3}\s+|\p{Sc}\s*)/u, '')
      .replace(/(?:\s+[A-Z]{3}|\s*\p{Sc})$/u, '')
      .trim();
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return undefined;
    const value = Number(normalized);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  private fieldType(field: ExpenseField): string {
    return this.normalize(field.Type?.Text);
  }

  private fieldValue(field: ExpenseField): string | undefined {
    const value = field.ValueDetection?.Text?.trim();
    return value || undefined;
  }

  private groupTypes(field: ExpenseField): string[] {
    return (field.GroupProperties ?? []).flatMap((group) =>
      (group.Types ?? []).map((type) => this.normalize(type)),
    );
  }

  private normalize(text: string | undefined): string {
    return (text ?? '')
      .trim()
      .replace(/^[\s:;,.\-]+|[\s:;,.\-]+$/g, '')
      .replace(/\s+/g, ' ')
      .toUpperCase();
  }
}
