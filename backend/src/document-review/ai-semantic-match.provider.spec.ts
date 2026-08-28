/// <reference types="jest" />

import { AiSemanticMatchProvider } from './ai-semantic-match.provider';

const HUMAN_BEARER_TOKEN = 'human-reviewer-token';
const ERP_USER_ID = 7;

/** Builds a fetch Response whose body streams AgentCore-shaped SSE "data: {...}" lines. */
function sseResponse(events: object[], init: { ok?: boolean; status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body,
  } as unknown as Response;
}

describe('AiSemanticMatchProvider', () => {
  const ORIGINAL_URL = process.env.SEMANTIC_MATCH_SERVICE_URL;
  const ORIGINAL_TIMEOUT = process.env.SEMANTIC_MATCH_TIMEOUT_MS;
  const ORIGINAL_FETCH = global.fetch;

  // Node coerces `process.env.X = undefined` to the literal STRING
  // "undefined" rather than leaving X unset - restoring via a plain
  // assignment would silently turn a never-set var into a truthy one for
  // every later test in this file. Delete instead when the original value
  // was genuinely absent.
  function restoreEnv(name: string, original: string | undefined): void {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }

  afterEach(() => {
    restoreEnv('SEMANTIC_MATCH_SERVICE_URL', ORIGINAL_URL);
    restoreEnv('SEMANTIC_MATCH_TIMEOUT_MS', ORIGINAL_TIMEOUT);
    global.fetch = ORIGINAL_FETCH;
  });

  it('throws immediately, without attempting a network call, when SEMANTIC_MATCH_SERVICE_URL is not configured', async () => {
    delete process.env.SEMANTIC_MATCH_SERVICE_URL;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();

    await expect(
      provider.matchProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Query', [
        { id: 1, name: 'X', category: null, description: null },
      ]),
    ).rejects.toThrow('SEMANTIC_MATCH_SERVICE_URL is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws immediately when no human bearer token is provided', async () => {
    process.env.SEMANTIC_MATCH_SERVICE_URL = 'http://ai-agent.internal:8081';
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();

    await expect(
      provider.matchProduct('', ERP_USER_ID, 'Query', [
        { id: 1, name: 'X', category: null, description: null },
      ]),
    ).rejects.toThrow('A human bearer token is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs mode=document_match to /invocations with the human bearer token, a fresh erp-user session id, and the JSON-encoded request', async () => {
    process.env.SEMANTIC_MATCH_SERVICE_URL = 'http://ai-agent.internal:8081/';
    const fetchMock = jest.fn().mockResolvedValue(
      sseResponse([
        {
          type: 'text_delta',
          text: JSON.stringify({
            status: 'RESOLVED',
            candidates: [
              { id: 73, name: 'Laptop Pro 14', confidence: 0.97, reason: 'Same product, different wording.' },
            ],
            recommendation: null,
          }),
        },
        { type: 'done' },
      ]),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();
    const result = await provider.matchProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Laptop Pro 14', [
      { id: 73, name: 'Laptop Pro 14', category: 'Electronics', description: null },
    ]);

    expect(result).toEqual({
      status: 'RESOLVED',
      candidates: [
        { id: 73, name: 'Laptop Pro 14', confidence: 0.97, reason: 'Same product, different wording.' },
      ],
      recommendation: null,
    });

    const [calledUrl, init] = fetchMock.mock.calls[0];
    // Trailing slash on the base URL is stripped - no double slash.
    expect(calledUrl).toBe('http://ai-agent.internal:8081/invocations');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Accept']).toBe('text/event-stream');
    expect(init.headers['Authorization']).toBe(`Bearer ${HUMAN_BEARER_TOKEN}`);
    const sessionId = init.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'];
    expect(sessionId).toMatch(/^erp-user-7-[0-9a-f]{32}$/);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(init.body);
    expect(body.mode).toBe('document_match');
    const prompt = JSON.parse(body.prompt);
    expect(prompt).toEqual({
      entityType: 'product',
      query: 'Laptop Pro 14',
      candidates: [{ id: 73, name: 'Laptop Pro 14', category: 'Electronics', description: null }],
    });
  });

  it('mints a different session id on every call — never reused', async () => {
    process.env.SEMANTIC_MATCH_SERVICE_URL = 'http://ai-agent.internal:8081';
    // A fresh ReadableStream per call — a Response's body can only be read
    // once, so reusing a single mockResolvedValue() across two calls would
    // hand the second call an already-locked stream.
    const fetchMock = jest.fn().mockImplementation(() =>
      Promise.resolve(
        sseResponse([
          { type: 'text_delta', text: JSON.stringify({ status: 'NO_MATCH', candidates: [], recommendation: null }) },
          { type: 'done' },
        ]),
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();
    await provider.matchProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'A', [
      { id: 1, name: 'X', category: null, description: null },
    ]);
    await provider.matchProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'B', [
      { id: 1, name: 'X', category: null, description: null },
    ]);

    const sessionIds = fetchMock.mock.calls.map(
      (call: unknown[]) => (call[1] as { headers: Record<string, string> }).headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'],
    );
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
  });

  it('sends entityType=supplier and the real supplier metadata for matchSupplier', async () => {
    process.env.SEMANTIC_MATCH_SERVICE_URL = 'http://ai-agent.internal:8081';
    const fetchMock = jest.fn().mockResolvedValue(
      sseResponse([
        { type: 'text_delta', text: JSON.stringify({ status: 'NO_MATCH', candidates: [], recommendation: null }) },
        { type: 'done' },
      ]),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();
    await provider.matchSupplier(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'X', [
      { id: 41, name: 'TechSource Lebanon', email: 'a@b.com', leadTimeDays: 5 },
    ]);

    const [, init] = fetchMock.mock.calls[0];
    const prompt = JSON.parse(JSON.parse(init.body).prompt);
    expect(prompt.entityType).toBe('supplier');
    expect(prompt.candidates).toEqual([
      { id: 41, name: 'TechSource Lebanon', email: 'a@b.com', leadTimeDays: 5 },
    ]);
  });

  it('throws when an in-stream "error" event arrives, without leaking its message', async () => {
    process.env.SEMANTIC_MATCH_SERVICE_URL = 'http://ai-agent.internal:8081';
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([{ type: 'error', message: 'The assistant could not complete this request.' }]),
    ) as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();

    await expect(
      provider.matchProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'X', []),
    ).rejects.toThrow('AgentCore reported an error');
  });

  it('throws when the stream closes without a "done" event and no text was ever collected', async () => {
    process.env.SEMANTIC_MATCH_SERVICE_URL = 'http://ai-agent.internal:8081';
    global.fetch = jest.fn().mockResolvedValue(sseResponse([{ type: 'tool_status', label: 'Working...' }])) as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();

    await expect(
      provider.matchProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'X', []),
    ).rejects.toThrow('stream closed without a result');
  });

  it('throws when the HTTP response is not ok', async () => {
    process.env.SEMANTIC_MATCH_SERVICE_URL = 'http://ai-agent.internal:8081';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, body: null }) as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();

    await expect(provider.matchProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'X', [])).rejects.toThrow(
      'AgentCore document_match request returned HTTP 500',
    );
  });

  it('throws when the network request itself fails', async () => {
    process.env.SEMANTIC_MATCH_SERVICE_URL = 'http://ai-agent.internal:8081';
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();

    await expect(provider.matchProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'X', [])).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('fails cleanly when the configured timeout is reached', async () => {
    process.env.SEMANTIC_MATCH_SERVICE_URL = 'http://ai-agent.internal:8081';
    process.env.SEMANTIC_MATCH_TIMEOUT_MS = '10';
    global.fetch = jest.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }
        const rejectWithSignalReason = () => reject(signal.reason);
        if (signal.aborted) {
          rejectWithSignalReason();
        } else {
          signal.addEventListener('abort', rejectWithSignalReason, { once: true });
        }
      }),
    ) as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();

    await expect(provider.matchProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Slow', [])).rejects.toThrow(
      'AgentCore document_match request timed out after 10ms',
    );
  });

  it('throws when the collected result is not valid JSON', async () => {
    process.env.SEMANTIC_MATCH_SERVICE_URL = 'http://ai-agent.internal:8081';
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([{ type: 'text_delta', text: 'not json' }, { type: 'done' }]),
    ) as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();

    await expect(provider.matchProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'X', [])).rejects.toThrow();
  });

  it('throws when the response body is not in the expected shape', async () => {
    process.env.SEMANTIC_MATCH_SERVICE_URL = 'http://ai-agent.internal:8081';
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([{ type: 'text_delta', text: JSON.stringify({ unexpected: true }) }, { type: 'done' }]),
    ) as unknown as typeof fetch;

    const provider = new AiSemanticMatchProvider();

    await expect(provider.matchProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'X', [])).rejects.toThrow(
      'Document match response was not in the expected shape',
    );
  });
});
