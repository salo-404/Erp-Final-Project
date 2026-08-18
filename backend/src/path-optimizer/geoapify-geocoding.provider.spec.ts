/// <reference types="jest" />

import { GeoapifyGeocodingProvider } from './geoapify-geocoding.provider';

describe('GeoapifyGeocodingProvider', () => {
  const ORIGINAL_API_KEY = process.env.GEOAPIFY_API_KEY;
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    process.env.GEOAPIFY_API_KEY = ORIGINAL_API_KEY;
    global.fetch = ORIGINAL_FETCH;
  });

  it('throws when GEOAPIFY_API_KEY is not configured', () => {
    delete process.env.GEOAPIFY_API_KEY;

    expect(() => new GeoapifyGeocodingProvider()).toThrow(
      'GEOAPIFY_API_KEY is not configured',
    );
  });

  it('geocodes an address via Geoapify Forward Geocoding, without ever hitting the real network', async () => {
    process.env.GEOAPIFY_API_KEY = 'test-key';
    const fetchMock = jest
      .fn<
        Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
        [string]
      >()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            results: [
              { lat: 34.05, lon: -118.25, formatted: '1 Market St, CA, USA' },
            ],
          }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new GeoapifyGeocodingProvider();
    const result = await provider.geocode('1 Market St, CA, USA');

    expect(result).toEqual({
      coordinates: { latitude: 34.05, longitude: -118.25 },
      formattedAddress: '1 Market St, CA, USA',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const calledUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(calledUrl.origin + calledUrl.pathname).toBe(
      'https://api.geoapify.com/v1/geocode/search',
    );
    expect(calledUrl.searchParams.get('text')).toBe('1 Market St, CA, USA');
    expect(calledUrl.searchParams.get('format')).toBe('json');
    expect(calledUrl.searchParams.get('limit')).toBe('1');
    expect(calledUrl.searchParams.get('apiKey')).toBe('test-key');
  });

  it('throws when the HTTP response is not ok', async () => {
    process.env.GEOAPIFY_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });

    const provider = new GeoapifyGeocodingProvider();

    await expect(provider.geocode('X')).rejects.toThrow(
      'Geoapify returned HTTP 403',
    );
  });

  it('throws when the network request itself fails', async () => {
    process.env.GEOAPIFY_API_KEY = 'test-key';
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const provider = new GeoapifyGeocodingProvider();

    await expect(provider.geocode('X')).rejects.toThrow(
      'Geoapify request failed for address "X": ECONNREFUSED',
    );
  });

  it('throws when Geoapify returns no results', async () => {
    process.env.GEOAPIFY_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ results: [] }),
    });

    const provider = new GeoapifyGeocodingProvider();

    await expect(provider.geocode('Nowhere')).rejects.toThrow(
      'Geoapify found no results for address "Nowhere"',
    );
  });

  it('never includes the API key in a thrown error message', async () => {
    process.env.GEOAPIFY_API_KEY = 'super-secret-key';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    const provider = new GeoapifyGeocodingProvider();
    let caught: Error | undefined;

    try {
      await provider.geocode('X');
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain('super-secret-key');
  });
});
