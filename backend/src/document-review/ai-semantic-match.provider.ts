import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  DocumentMatchResult,
  DocumentSemanticMatchProvider,
} from './document-review.service';

// A real LLM reasoning call (the Document agent), not just an embedding
// call — deliberately generous, and comfortably above ai-agent's own
// DOCUMENT_MATCHING_TIMEOUT_SECONDS default (12s) so this client doesn't
// cut the request off before the AI service's own timeout would have
// fired first.
const DEFAULT_AGENTCORE_TIMEOUT_MS = 15000;

const DOCUMENT_MATCH_MODE = 'document_match';

interface AgentCoreSseEvent {
  type?: 'text_delta' | 'tool_status' | 'done' | 'error';
  text?: string;
  message?: string;
}

/**
 * Real implementation of DocumentSemanticMatchProvider (see that
 * interface's own docstring in document-review.service.ts) — calls the AI
 * service's REAL AgentCore Runtime endpoint, POST {baseUrl}/invocations,
 * the exact same endpoint the chat UI streams from
 * (frontend/src/agent/agentCoreService.ts), using "mode": "document_match"
 * (see ai-agent/agentcore_entrypoint.py's invoke() docstring) so the
 * request reaches agents/document_agent/matching_agent.py's real Document
 * agent LLM call directly — never a bespoke HTTP route, never Supervisor
 * chat.
 *
 * Authenticates as the CURRENT reviewer, not a service account: the human
 * bearer token and ERP user id are forwarded in from
 * DocumentReviewController (see humanBearerToken() there), exactly the
 * same identity AgentCore's own /auth/me + session-ownership checks
 * already enforce for ordinary chat. A fresh, single-use runtime session
 * ID is minted per call (erp-user-{id}-{32-hex}, matching
 * ai-agent/agentcore_session.py's required format) — mirrors how
 * frontend/src/agent/agentCoreService.ts's sendControlTowerRecommendation()
 * mints its own fresh session per one-shot call; nothing here is ever
 * reused across requests or tied to a reviewer's real chat history.
 *
 * SEMANTIC_MATCH_SERVICE_URL / SEMANTIC_MATCH_TIMEOUT_MS are read from
 * process.env directly (loaded via dotenv/config in main.ts) — same
 * convention as GeoapifyGeocodingProvider. When SEMANTIC_MATCH_SERVICE_URL
 * is unset, every call throws immediately without attempting a network
 * request — the caller (DocumentReviewService.resolveProduct()/
 * resolveSupplier()) always catches this and falls back to its own
 * Jaccard-token matcher, so an unconfigured deployment behaves exactly as
 * it did before this feature.
 */
@Injectable()
export class AiSemanticMatchProvider implements DocumentSemanticMatchProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl = (process.env.SEMANTIC_MATCH_SERVICE_URL ?? '').replace(
      /\/+$/,
      '',
    );
    const configuredTimeout = Number(process.env.SEMANTIC_MATCH_TIMEOUT_MS);
    this.timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_AGENTCORE_TIMEOUT_MS;
  }

  async matchProduct(
    humanBearerToken: string,
    erpUserId: number,
    query: string,
    candidates: {
      id: number;
      name: string;
      category: string | null;
      description: string | null;
    }[],
  ): Promise<DocumentMatchResult> {
    return this.invokeDocumentMatch(humanBearerToken, erpUserId, {
      entityType: 'product',
      query,
      candidates,
    });
  }

  async matchSupplier(
    humanBearerToken: string,
    erpUserId: number,
    query: string,
    candidates: {
      id: number;
      name: string;
      email?: string | null;
      leadTimeDays?: number | null;
    }[],
  ): Promise<DocumentMatchResult> {
    return this.invokeDocumentMatch(humanBearerToken, erpUserId, {
      entityType: 'supplier',
      query,
      candidates,
    });
  }

  private async invokeDocumentMatch(
    humanBearerToken: string,
    erpUserId: number,
    requestBody: { entityType: 'product' | 'supplier'; query: string; candidates: unknown[] },
  ): Promise<DocumentMatchResult> {
    if (!this.baseUrl) {
      throw new Error('SEMANTIC_MATCH_SERVICE_URL is not configured');
    }
    if (!humanBearerToken) {
      throw new Error('A human bearer token is required to call AgentCore document_match');
    }

    const sessionId = `erp-user-${erpUserId}-${randomUUID().replace(/-/g, '')}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/invocations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${humanBearerToken}`,
          'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
        },
        body: JSON.stringify({
          prompt: JSON.stringify(requestBody),
          mode: DOCUMENT_MATCH_MODE,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (
        (error as Error).name === 'TimeoutError' ||
        (error as Error).name === 'AbortError'
      ) {
        throw new Error(`AgentCore document_match request timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`AgentCore document_match request failed: ${(error as Error).message}`);
    }

    if (!response.ok || !response.body) {
      throw new Error(`AgentCore document_match request returned HTTP ${response.status}`);
    }

    const text = await this.collectTextFromSseStream(response.body);
    const body = JSON.parse(text) as DocumentMatchResult;
    if (!body || !Array.isArray(body.candidates) || !body.status) {
      throw new Error('Document match response was not in the expected shape');
    }
    return body;
  }

  /**
   * Reads the AgentCore SSE stream (the SAME text_delta/done/error event
   * vocabulary the chat UI's frontend/src/agent/agentCoreService.ts
   * parses) and returns the concatenated text_delta text once "done"
   * arrives. document_match mode always emits its full JSON result as a
   * single text_delta (see agentcore_entrypoint.py) — there is no
   * incremental token streaming to render here, just one event to collect.
   * Throws on an "error" event (never leaks its generic message beyond
   * "AgentCore reported an error" - the real detail was already
   * intentionally scrubbed server-side, see _STREAM_ERROR_MESSAGE in
   * agentcore_entrypoint.py) or if the stream closes without "done".
   */
  private async collectTextFromSseStream(
    body: ReadableStream<Uint8Array>,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let collected = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonText = trimmed.slice(5).trim();
          if (!jsonText) continue;
          let event: AgentCoreSseEvent;
          try {
            event = JSON.parse(jsonText) as AgentCoreSseEvent;
          } catch {
            continue;
          }
          if (event.type === 'text_delta' && event.text) {
            collected += event.text;
          } else if (event.type === 'error') {
            throw new Error('AgentCore reported an error while processing document_match');
          } else if (event.type === 'done') {
            return collected;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    if (!collected) {
      throw new Error('AgentCore document_match stream closed without a result');
    }
    return collected;
  }
}
