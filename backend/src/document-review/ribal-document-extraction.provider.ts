import { Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  DocumentExtractionProvider,
  ExtractedDocumentData,
  validateExtractedDocumentData,
} from './document-review.service';

const DEFAULT_RIBAL_AGENT_TIMEOUT_MS = 30000;

/**
 * NestJS-side boundary for Ribal's document-extraction agent
 * (AgentCore/Bedrock) — this class does NOT implement any AI/Bedrock logic
 * itself. It is a plain HTTP adapter: POST { mimeType, documentUrl } to
 * whatever endpoint RIBAL_AGENT_URL points at, and expect back JSON
 * matching ExtractedDocumentData. Ribal's own agent lives behind that URL;
 * this file only gives it somewhere to plug into DI, same pattern as
 * GeoapifyGeocodingProvider in path-optimizer/ — real external call, bound
 * via DI token, URL/config read from environment, never hard-coded.
 *
 * The document itself is never sent in the request body — only the
 * temporary presigned URL the extraction agent fetches it from directly.
 */
@Injectable()
export class RibalDocumentExtractionProvider implements DocumentExtractionProvider {
  private readonly agentUrl: string;
  private readonly timeoutMs: number;

  constructor() {
    const agentUrl = process.env.RIBAL_AGENT_URL;
    if (!agentUrl) {
      throw new InternalServerErrorException(
        'RIBAL_AGENT_URL is not configured — set it in .env to use RibalDocumentExtractionProvider',
      );
    }
    this.agentUrl = agentUrl;
    const configuredTimeout = Number(process.env.RIBAL_AGENT_TIMEOUT_MS);
    this.timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_RIBAL_AGENT_TIMEOUT_MS;
  }

  async extract(input: {
    mimeType: string;
    documentUrl: string;
  }): Promise<ExtractedDocumentData> {
    let response: Response;
    try {
      response = await fetch(this.agentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mimeType: input.mimeType,
          documentUrl: input.documentUrl,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (
        (error as Error).name === 'TimeoutError' ||
        (error as Error).name === 'AbortError'
      ) {
        throw new InternalServerErrorException(
          `Ribal extraction request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new InternalServerErrorException(
        `Ribal extraction request failed: ${(error as Error).message}`,
      );
    }

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Ribal extraction agent returned HTTP ${response.status}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new InternalServerErrorException(
        'Ribal extraction agent returned malformed JSON',
      );
    }
    return validateExtractedDocumentData(body);
  }
}
