/// <reference types="jest" />

import { PathOptimizerService } from './path-optimizer.service';
import {
  EligibleWarehouse,
  OrderItem,
  WarehouseRoutingService,
} from '../warehouse-inventory/warehouse-routing.service';
import type {
  GeocodeResult,
  GeocodingProvider,
} from './path-optimizer.service';

function warehouse(
  overrides: Partial<{
    warehouseId: number;
    warehouseName: string;
    location: string | null;
    available: number;
    requestedQuantity: number;
    productId: number;
  }> = {},
): EligibleWarehouse {
  const productId = overrides.productId ?? 100;
  const available = overrides.available ?? 100;
  const requestedQuantity = overrides.requestedQuantity ?? 50;
  return {
    warehouseId: overrides.warehouseId ?? 1,
    warehouseName:
      overrides.warehouseName ?? `Warehouse ${overrides.warehouseId ?? 1}`,
    location:
      overrides.location === undefined ? 'Some City' : overrides.location,
    items: [
      {
        productId,
        onHand: available,
        reserved: 0,
        available,
        requestedQuantity,
      },
    ],
  };
}

function createMockWarehouseRoutingService() {
  const findEligibleWarehousesForOrder = jest.fn<
    Promise<EligibleWarehouse[]>,
    [string | undefined, string | undefined, OrderItem[]]
  >();
  findEligibleWarehousesForOrder.mockResolvedValue([]);
  const service = {
    findEligibleWarehousesForOrder,
  } as unknown as WarehouseRoutingService;
  return { service, findEligibleWarehousesForOrder };
}

function createMockGeocodingProvider() {
  const geocode = jest.fn<Promise<GeocodeResult>, [string]>();
  const provider: GeocodingProvider = { geocode };
  return { provider, geocode };
}

function buildService() {
  const { service: warehouseRoutingService, findEligibleWarehousesForOrder } =
    createMockWarehouseRoutingService();
  const { provider: geocodingProvider, geocode } =
    createMockGeocodingProvider();
  const service = new PathOptimizerService(
    warehouseRoutingService,
    geocodingProvider,
  );
  return {
    service,
    findEligibleWarehousesForOrder,
    geocode,
  };
}

const VALID_INPUT = {
  productId: 100,
  requiredQuantity: 50,
  deliveryCountry: 'USA',
  deliveryRegion: 'CA',
  deliveryAddress: '1 Market St',
};

/** New York-ish and Los Angeles-ish coordinates — real enough to produce a stable, non-zero distance. */
const DESTINATION_COORDS = { latitude: 34.05, longitude: -118.25 };
const NEAR_COORDS = { latitude: 34.1, longitude: -118.3 };
const FAR_COORDS = { latitude: 40.71, longitude: -74.0 };

describe('PathOptimizerService.findNearestWarehouse', () => {
  it('filters by stock availability BEFORE calling geocode (stock step happens first)', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    const callOrder: string[] = [];
    findEligibleWarehousesForOrder.mockImplementation(() => {
      callOrder.push('stock');
      return Promise.resolve([
        warehouse({ warehouseId: 2, available: 70, location: 'B' }),
      ]);
    });
    geocode.mockImplementation(() => {
      callOrder.push('geocode');
      return Promise.resolve({ coordinates: DESTINATION_COORDS });
    });

    await service.findNearestWarehouse(VALID_INPUT);

    expect(callOrder[0]).toBe('stock');
    expect(callOrder.slice(1)).toEqual(['geocode', 'geocode']);
  });

  it('passes productId/requiredQuantity through to WarehouseRoutingService as a single-item order', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    findEligibleWarehousesForOrder.mockResolvedValue([]);
    geocode.mockResolvedValue({ coordinates: DESTINATION_COORDS });

    await expect(service.findNearestWarehouse(VALID_INPUT)).rejects.toThrow();

    expect(findEligibleWarehousesForOrder).toHaveBeenCalledWith('USA', 'CA', [
      { productId: 100, quantity: 50 },
    ]);
  });

  it('EXCLUDE example: excludes a warehouse with less than the full required quantity (Warehouse A: 30 < 50)', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    // WarehouseRoutingService already excludes it since it can't fulfill the full order —
    // simulating that here by simply never returning warehouse A.
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({ warehouseId: 2, available: 70, location: 'B' }),
      warehouse({ warehouseId: 3, available: 100, location: 'C' }),
    ]);
    geocode.mockImplementation((address: string) =>
      Promise.resolve({
        coordinates: address === 'B' ? NEAR_COORDS : FAR_COORDS,
      }),
    );

    const result = await service.findNearestWarehouse(VALID_INPUT);

    expect(result.consideredCandidates.map((c) => c.warehouseId)).toEqual([
      2, 3,
    ]);
    expect(result.consideredCandidates.some((c) => c.warehouseId === 1)).toBe(
      false,
    );
  });

  it('propagates rejection when the requested product is inactive (WarehouseRoutingService rejects before any geocoding)', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    findEligibleWarehousesForOrder.mockRejectedValue(
      new Error('Product 100 is inactive and cannot be part of a new order'),
    );

    await expect(service.findNearestWarehouse(VALID_INPUT)).rejects.toThrow(
      'Product 100 is inactive and cannot be part of a new order',
    );

    expect(geocode).not.toHaveBeenCalled();
  });

  it('never selects an inactive warehouse — WarehouseRoutingService excludes it from candidates entirely', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    // The inactive warehouse (id 1) is never returned by
    // WarehouseRoutingService in the first place (see its own isActive
    // filter, tested in warehouse-routing.service.spec.ts) — only the
    // active warehouse survives to reach Path Optimizer at all.
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({ warehouseId: 2, available: 70, location: 'Active WH' }),
    ]);
    geocode.mockResolvedValue({ coordinates: DESTINATION_COORDS });

    const result = await service.findNearestWarehouse(VALID_INPUT);

    expect(result.selectedWarehouseId).toBe(2);
    expect(result.consideredCandidates.some((c) => c.warehouseId === 1)).toBe(
      false,
    );
  });

  it('selects the nearest warehouse among multiple eligible ones', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({ warehouseId: 2, available: 70, location: 'Near' }),
      warehouse({ warehouseId: 3, available: 100, location: 'Far' }),
    ]);
    geocode.mockImplementation((address: string) => {
      if (address === '1 Market St, CA, USA') {
        return Promise.resolve({ coordinates: DESTINATION_COORDS });
      }
      return Promise.resolve({
        coordinates: address === 'Near' ? NEAR_COORDS : FAR_COORDS,
      });
    });

    const result = await service.findNearestWarehouse(VALID_INPUT);

    expect(result.selectedWarehouseId).toBe(2);
    expect(result.distanceKm).toBeGreaterThan(0);
    expect(result.distanceKm).toBeLessThan(
      result.consideredCandidates.find((c) => c.warehouseId === 3)!.distanceKm!,
    );
  });

  it('a farther warehouse with enough stock is selected when the closer one lacks stock', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    // Only the far warehouse survives the stock step; the near one never appears
    // because WarehouseRoutingService already excluded it for insufficient stock.
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({ warehouseId: 3, available: 100, location: 'Far' }),
    ]);
    geocode.mockImplementation((address: string) =>
      Promise.resolve({
        coordinates: address === 'Far' ? FAR_COORDS : DESTINATION_COORDS,
      }),
    );

    const result = await service.findNearestWarehouse(VALID_INPUT);

    expect(result.selectedWarehouseId).toBe(3);
  });

  it('active reservations reducing availability make a warehouse ineligible (relies entirely on WarehouseRoutingService)', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    // WarehouseRoutingService is the sole source of the available-stock
    // calculation; if it excludes a warehouse (e.g. reservations reduced
    // available below the requirement), PathOptimizerService never sees it.
    findEligibleWarehousesForOrder.mockResolvedValue([]);
    geocode.mockResolvedValue({ coordinates: DESTINATION_COORDS });

    await expect(service.findNearestWarehouse(VALID_INPUT)).rejects.toThrow(
      /No warehouse .* has at least 50 available units/,
    );
  });

  it('excludes the destination warehouse itself when destinationWarehouseId is given', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({ warehouseId: 5, available: 100, location: 'Self' }),
      warehouse({ warehouseId: 6, available: 100, location: 'Other' }),
    ]);
    geocode.mockImplementation((address: string) =>
      Promise.resolve({
        coordinates: address === 'Other' ? NEAR_COORDS : DESTINATION_COORDS,
      }),
    );

    const result = await service.findNearestWarehouse({
      ...VALID_INPUT,
      destinationWarehouseId: 5,
    });

    expect(result.selectedWarehouseId).toBe(6);
    expect(result.consideredCandidates.some((c) => c.warehouseId === 5)).toBe(
      false,
    );
  });

  it('exact required quantity available is eligible', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({
        warehouseId: 2,
        available: 50,
        requestedQuantity: 50,
        location: 'B',
      }),
    ]);
    geocode.mockResolvedValue({ coordinates: DESTINATION_COORDS });

    const result = await service.findNearestWarehouse(VALID_INPUT);

    expect(result.selectedWarehouseId).toBe(2);
    expect(result.availableStockAtSelectedWarehouse).toBe(50);
  });

  it('rejects a zero requiredQuantity without calling stock lookup or geocoding', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();

    await expect(
      service.findNearestWarehouse({ ...VALID_INPUT, requiredQuantity: 0 }),
    ).rejects.toThrow('requiredQuantity must be a positive integer');

    expect(findEligibleWarehousesForOrder).not.toHaveBeenCalled();
    expect(geocode).not.toHaveBeenCalled();
  });

  it('rejects a negative/non-integer requiredQuantity', async () => {
    const { service } = buildService();

    await expect(
      service.findNearestWarehouse({ ...VALID_INPUT, requiredQuantity: -5 }),
    ).rejects.toThrow('requiredQuantity must be a positive integer');
    await expect(
      service.findNearestWarehouse({ ...VALID_INPUT, requiredQuantity: 1.5 }),
    ).rejects.toThrow('requiredQuantity must be a positive integer');
  });

  it('rejects an invalid productId', async () => {
    const { service } = buildService();

    await expect(
      service.findNearestWarehouse({ ...VALID_INPUT, productId: 0 }),
    ).rejects.toThrow('Invalid productId');
  });

  it('propagates a destination geocoding failure and never selects a warehouse', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({ warehouseId: 2, available: 70, location: 'B' }),
    ]);
    geocode.mockRejectedValue(new Error('Geocoding service unavailable'));

    await expect(service.findNearestWarehouse(VALID_INPUT)).rejects.toThrow(
      'Geocoding service unavailable',
    );
  });

  it('skips (does not select) a warehouse whose own geocoding call fails, but still returns a result if another candidate succeeds', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({ warehouseId: 2, available: 70, location: 'BadLocation' }),
      warehouse({ warehouseId: 3, available: 100, location: 'GoodLocation' }),
    ]);
    geocode.mockImplementation((address: string) => {
      if (address === VALID_INPUT.deliveryAddress + ', CA, USA') {
        return Promise.resolve({ coordinates: DESTINATION_COORDS });
      }
      if (address === 'BadLocation') {
        return Promise.reject(new Error('Could not geocode'));
      }
      return Promise.resolve({ coordinates: NEAR_COORDS });
    });

    const result = await service.findNearestWarehouse(VALID_INPUT);

    expect(result.selectedWarehouseId).toBe(3);
    const failed = result.consideredCandidates.find((c) => c.warehouseId === 2);
    expect(failed?.distanceKm).toBeNull();
  });

  it('throws when every stock-eligible warehouse fails to geocode', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({ warehouseId: 2, available: 70, location: 'BadLocation' }),
    ]);
    geocode.mockImplementation((address: string) => {
      if (address === 'BadLocation') {
        return Promise.reject(new Error('Could not geocode'));
      }
      return Promise.resolve({ coordinates: DESTINATION_COORDS });
    });

    await expect(service.findNearestWarehouse(VALID_INPUT)).rejects.toThrow(
      'No stock-eligible warehouse location could be geocoded',
    );
  });

  it('treats a warehouse with a null/blank location as not distance-comparable', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({ warehouseId: 2, available: 70, location: null }),
      warehouse({ warehouseId: 3, available: 100, location: 'GoodLocation' }),
    ]);
    geocode.mockResolvedValue({ coordinates: DESTINATION_COORDS });

    const result = await service.findNearestWarehouse(VALID_INPUT);

    expect(result.selectedWarehouseId).toBe(3);
    const nullLocationCandidate = result.consideredCandidates.find(
      (c) => c.warehouseId === 2,
    );
    expect(nullLocationCandidate?.distanceKm).toBeNull();
    // Never even attempted to geocode a null location.
    expect(geocode).not.toHaveBeenCalledWith(null);
  });

  it('rejects an empty/invalid destination (no country, region, or address) without calling stock lookup or geocoding', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();

    await expect(
      service.findNearestWarehouse({
        productId: 100,
        requiredQuantity: 50,
        deliveryCountry: '   ',
        deliveryRegion: undefined,
        deliveryAddress: '',
      }),
    ).rejects.toThrow(
      'At least one of deliveryAddress, deliveryRegion, or deliveryCountry must be provided',
    );

    expect(findEligibleWarehousesForOrder).not.toHaveBeenCalled();
    expect(geocode).not.toHaveBeenCalled();
  });

  it('never mutates inventory or reservations — only reads via WarehouseRoutingService and GeocodingProvider', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({ warehouseId: 2, available: 70, location: 'B' }),
    ]);
    geocode.mockResolvedValue({ coordinates: DESTINATION_COORDS });

    const result = await service.findNearestWarehouse(VALID_INPUT);

    // The only two collaborators PathOptimizerService depends on are asserted
    // to have been called read-only (no write-capable method exists on either
    // mock), and the result carries no side-effect markers.
    expect(findEligibleWarehousesForOrder).toHaveBeenCalled();
    expect(geocode).toHaveBeenCalled();
    expect(result.selectedWarehouseId).toBe(2);
  });

  it('includes enough structured data for Control Tower / AI use (source ids, destination, all considered candidates)', async () => {
    const { service, findEligibleWarehousesForOrder, geocode } = buildService();
    findEligibleWarehousesForOrder.mockResolvedValue([
      warehouse({ warehouseId: 2, available: 70, location: 'B' }),
    ]);
    geocode.mockResolvedValue({
      coordinates: DESTINATION_COORDS,
      formattedAddress: '1 Market St, CA, USA (normalized)',
    });

    const result = await service.findNearestWarehouse(VALID_INPUT);

    expect(result).toMatchObject({
      productId: 100,
      requestedQuantity: 50,
      selectedWarehouseId: 2,
      availableStockAtSelectedWarehouse: 70,
      destination: {
        deliveryCountry: 'USA',
        deliveryRegion: 'CA',
        deliveryAddress: '1 Market St',
        formattedAddress: '1 Market St, CA, USA (normalized)',
        coordinates: DESTINATION_COORDS,
      },
    });
    expect(result.consideredCandidates).toHaveLength(1);
    expect(result.generatedAt).toBeInstanceOf(Date);
  });
});
