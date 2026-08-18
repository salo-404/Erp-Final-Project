/// <reference types="jest" />

import { RibalDocumentExtractionProvider } from './ribal-document-extraction.provider';

describe('RibalDocumentExtractionProvider', () => {
  const ORIGINAL_AGENT_URL = process.env.RIBAL_AGENT_URL;
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    process.env.RIBAL_AGENT_URL = ORIGINAL_AGENT_URL;
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
});
