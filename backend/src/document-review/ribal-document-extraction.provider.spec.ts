/// <reference types="jest" />

import { RibalDocumentExtractionProvider } from './ribal-document-extraction.provider';

describe('RibalDocumentExtractionProvider', () => {
  const ORIGINAL_AGENT_URL = process.env.RIBAL_AGENT_URL;
  const ORIGINAL_TIMEOUT = process.env.RIBAL_AGENT_TIMEOUT_MS;
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    process.env.RIBAL_AGENT_URL = ORIGINAL_AGENT_URL;
    process.env.RIBAL_AGENT_TIMEOUT_MS = ORIGINAL_TIMEOUT;
    global.fetch = ORIGINAL_FETCH;
  });

  it('throws when RIBAL_AGENT_URL is not configured', () => {
    delete process.env.RIBAL_AGENT_URL;

    expect(() => new RibalDocumentExtractionProvider()).toThrow(
      'RIBAL_AGENT_URL is not configured',
    );
  });

  it('POSTs { mimeType, documentUrl } to RIBAL_AGENT_URL and returns the parsed extraction result, never sending a Buffer', async () => {
    process.env.RIBAL_AGENT_URL = 'https://ribal.example.com/extract';
    const extractionResult = {
      transactionType: 'INCOMING',
      supplierName: 'Acme Supplies',
      items: [{ product: 'Widget', quantity: 5, price: 10 }],
    };
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(extractionResult),
    });
    global.fetch = fetchMock;

    const provider = new RibalDocumentExtractionProvider();
    const result = await provider.extract({
      mimeType: 'application/pdf',
      documentUrl: 'https://s3.example.com/doc.pdf?X-Amz-Signature=fake',
    });

    expect(result).toEqual(extractionResult);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ribal.example.com/extract');
    expect(options.method).toBe('POST');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    const sentBody = JSON.parse(options.body as string) as Record<
      string,
      unknown
    >;
    expect(sentBody).toEqual({
      mimeType: 'application/pdf',
      documentUrl: 'https://s3.example.com/doc.pdf?X-Amz-Signature=fake',
    });
    expect(sentBody).not.toHaveProperty('content');
  });

  it('throws when the HTTP response is not ok', async () => {
    process.env.RIBAL_AGENT_URL = 'https://ribal.example.com/extract';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    const provider = new RibalDocumentExtractionProvider();

    await expect(
      provider.extract({
        mimeType: 'application/pdf',
        documentUrl: 'https://s3.example.com/doc.pdf',
      }),
    ).rejects.toThrow('Ribal extraction agent returned HTTP 503');
  });

  it('throws when the network request itself fails', async () => {
    process.env.RIBAL_AGENT_URL = 'https://ribal.example.com/extract';
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const provider = new RibalDocumentExtractionProvider();

    await expect(
      provider.extract({
        mimeType: 'application/pdf',
        documentUrl: 'https://s3.example.com/doc.pdf',
      }),
    ).rejects.toThrow('Ribal extraction request failed: ECONNREFUSED');
  });

  it('fails cleanly with the actual AbortSignal.timeout reason', async () => {
    process.env.RIBAL_AGENT_URL = 'https://ribal.example.com/extract';
    process.env.RIBAL_AGENT_TIMEOUT_MS = '10';
    global.fetch = jest.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }
        const rejectWithReason = () => reject(signal.reason);
        if (signal.aborted) rejectWithReason();
        else signal.addEventListener('abort', rejectWithReason, { once: true });
      }),
    ) as unknown as typeof fetch;

    await expect(
      new RibalDocumentExtractionProvider().extract({
        mimeType: 'application/pdf',
        documentUrl: 'https://s3.example.com/doc.pdf',
      }),
    ).rejects.toThrow('Ribal extraction request timed out after 10ms');
  });

  it('rejects malformed JSON and invalid runtime extraction values', async () => {
    process.env.RIBAL_AGENT_URL = 'https://ribal.example.com/extract';
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('bad JSON')),
    });
    const provider = new RibalDocumentExtractionProvider();
    await expect(
      provider.extract({ mimeType: 'application/pdf', documentUrl: 'https://s3/doc' }),
    ).rejects.toThrow('Ribal extraction agent returned malformed JSON');

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        transactionType: 'INCOMING',
        items: [{ product: 'Widget', quantity: Number.NaN }],
      }),
    });
    await expect(
      provider.extract({ mimeType: 'application/pdf', documentUrl: 'https://s3/doc' }),
    ).rejects.toThrow('quantity must be a positive integer');
  });
});
