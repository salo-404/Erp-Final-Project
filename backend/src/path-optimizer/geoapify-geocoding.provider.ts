import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { GeocodeResult, GeocodingProvider } from './path-optimizer.service';

const GEOAPIFY_GEOCODE_URL = 'https://api.geoapify.com/v1/geocode/search';
const DEFAULT_GEOAPIFY_TIMEOUT_MS = 5000;

interface GeoapifyGeocodeResponseResult {
  lat: number;
  lon: number;
  formatted?: string;
}

interface GeoapifyGeocodeResponse {
  results?: GeoapifyGeocodeResponseResult[];
}

/**
 * Real Geoapify Forward Geocoding (https://api.geoapify.com/v1/geocode/search)
 * implementation of GeocodingProvider. The API key is read from
 * GEOAPIFY_API_KEY (set in .env, loaded via `dotenv/config` in main.ts) —
 * never hard-coded, never included in any response or error message this
 * class produces. Only `geocode()` is exposed; callers (PathOptimizerService)
 * never see the API key or the raw Geoapify request/response shape.
 */
@Injectable()
export class GeoapifyGeocodingProvider implements GeocodingProvider {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor() {
    const apiKey = process.env.GEOAPIFY_API_KEY;
    if (!apiKey) {
      throw new InternalServerErrorException(
        'GEOAPIFY_API_KEY is not configured — set it in .env to use GeoapifyGeocodingProvider',
      );
    }
    this.apiKey = apiKey;
    const configuredTimeout = Number(process.env.GEOAPIFY_TIMEOUT_MS);
    this.timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_GEOAPIFY_TIMEOUT_MS;
  }

  async geocode(address: string): Promise<GeocodeResult> {
    const url = new URL(GEOAPIFY_GEOCODE_URL);
    url.searchParams.set('text', address);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('apiKey', this.apiKey);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (
        (error as Error).name === 'TimeoutError' ||
        (error as Error).name === 'AbortError'
      ) {
        throw new InternalServerErrorException(
          `Geoapify request timed out after ${this.timeoutMs}ms for address "${address}"`,
        );
      }
      throw new InternalServerErrorException(
        `Geoapify request failed for address "${address}": ${(error as Error).message}`,
      );
    }

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Geoapify returned HTTP ${response.status} for address "${address}"`,
      );
    }

    const body = (await response.json()) as GeoapifyGeocodeResponse;
    const first = body.results?.[0];
    if (!first) {
      throw new InternalServerErrorException(
        `Geoapify found no results for address "${address}"`,
      );
    }

    return {
      coordinates: { latitude: first.lat, longitude: first.lon },
      formattedAddress: first.formatted,
    };
  }
}
