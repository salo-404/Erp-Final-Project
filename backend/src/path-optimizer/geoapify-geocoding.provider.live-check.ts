import 'dotenv/config';
import { GeoapifyGeocodingProvider } from './geoapify-geocoding.provider';

/**
 * Manual, on-demand check that GeoapifyGeocodingProvider actually reaches
 * the real Geoapify API using GEOAPIFY_API_KEY from .env. This file does
 * NOT end in `.spec.ts`, so Jest's testRegex (`.*\.spec\.ts$`) never picks
 * it up — normal `npm test` never calls the real network. Run it explicitly
 * with `npm run geoapify:live-check`.
 */
async function main() {
  const provider = new GeoapifyGeocodingProvider();
  const address = '1600 Amphitheatre Parkway, Mountain View, CA';

  const result = await provider.geocode(address);

  console.log('Geoapify live check succeeded for:', address);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error('Geoapify live check failed:', error);
  process.exitCode = 1;
});
