import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { WarehouseRoutingService } from '../warehouse-inventory/warehouse-routing.service';

export interface GeoCoordinates {
  latitude: number;
  longitude: number;
}

export interface GeocodeResult {
  coordinates: GeoCoordinates;
  /** Whatever normalized/formatted address string the provider returns, if any — purely informational, never persisted. */
  formattedAddress?: string;
}

/**
 * Port for the real geocoding/maps backend. PathOptimizerService depends
 * only on this interface, never a concrete HTTP client or vendor SDK — the
 * production binding is GeoapifyGeocodingProvider (see
 * geoapify-geocoding.provider.ts), wired up via GEOCODING_PROVIDER in
 * PathOptimizerModule. Tests inject their own mock implementation directly,
 * bypassing DI entirely.
 */
export interface GeocodingProvider {
  geocode(address: string): Promise<GeocodeResult>;
}

/**
 * DI token for GeocodingProvider — interfaces have no runtime identity in
 * TypeScript, so NestJS can't resolve `GeocodingProvider` by type alone the
 * way it does for concrete classes like WarehouseRoutingService.
 */
export const GEOCODING_PROVIDER = Symbol('GEOCODING_PROVIDER');

export interface FindNearestWarehouseInput {
  productId: number;
  requiredQuantity: number;
  deliveryCountry?: string;
  deliveryRegion?: string;
  deliveryAddress?: string;
  /**
   * Optional. Set this when the "destination" is itself a warehouse (e.g. an
   * internal replenishment lookup) so it is excluded as a candidate source
   * for itself. Not required for an ordinary customer order, where the
   * destination is a delivery address and no warehouse needs excluding.
   */
  destinationWarehouseId?: number;
}

export interface PathOptimizerCandidate {
  warehouseId: number;
  warehouseName: string;
  location: string | null;
  /** From WarehouseRoutingService — onHand minus ACTIVE reservations, not recomputed here. */
  available: number;
  /** null when this warehouse has no usable location string, or geocoding it failed. */
  distanceKm: number | null;
}

export interface PathOptimizerDestination {
  deliveryCountry?: string;
  deliveryRegion?: string;
  deliveryAddress?: string;
  formattedAddress?: string;
  coordinates: GeoCoordinates;
}

export interface PathOptimizerRecommendation {
  productId: number;
  requestedQuantity: number;
  destination: PathOptimizerDestination;
  selectedWarehouseId: number;
  selectedWarehouseName: string;
  selectedWarehouseLocation: string | null;
  availableStockAtSelectedWarehouse: number;
  distanceKm: number;
  /**
   * Every stock-eligible warehouse considered (not just the winner) — for
   * Control Tower / future AI integration, so nothing about the decision is
   * hidden behind just the final pick.
   */
  consideredCandidates: PathOptimizerCandidate[];
  generatedAt: Date;
}

const EARTH_RADIUS_KM = 6371;

@Injectable()
export class PathOptimizerService {
  constructor(
    private readonly warehouseRoutingService: WarehouseRoutingService,
    @Inject(GEOCODING_PROVIDER)
    private readonly geocodingProvider: GeocodingProvider,
  ) {}

  /**
   * Finds the nearest warehouse able to fully satisfy `requiredQuantity` of
   * `productId` for a customer/order destination.
   *
   * STEP 1 (stock, always first — before any geocoding call):
   * Delegates entirely to WarehouseRoutingService.findEligibleWarehousesForOrder()
   * for the available-stock calculation (onHand - ACTIVE reservations) —
   * never recomputed here. A warehouse only proceeds to geocoding if it can
   * fulfill the FULL requested quantity; the destination warehouse (if
   * `destinationWarehouseId` is given) is excluded from candidates.
   *
   * STEP 2 (geocoding, only for what survived step 1):
   * Geocodes the destination address once, then each surviving warehouse's
   * `location` — never the ones already excluded for insufficient stock.
   * A warehouse with no location string, or whose geocoding call fails, is
   * kept in `consideredCandidates` with `distanceKm: null` rather than
   * silently dropped, and is not eligible to be selected.
   *
   * STEP 3 (distance): great-circle (Haversine) distance in km between the
   * destination and each successfully-geocoded candidate; the smallest wins
   * (ties broken by warehouseId for determinism).
   *
   * Read-only throughout: no reservation, transfer, or InventoryTransaction
   * is created, and WarehouseInventory is never written.
   */
  async findNearestWarehouse(
    input: FindNearestWarehouseInput,
  ): Promise<PathOptimizerRecommendation> {
    this.validateInput(input);

    const eligibleWarehouses =
      await this.warehouseRoutingService.findEligibleWarehousesForOrder(
        input.deliveryCountry,
        input.deliveryRegion,
        [{ productId: input.productId, quantity: input.requiredQuantity }],
      );

    const stockEligible = eligibleWarehouses.filter(
      (warehouse) =>
        input.destinationWarehouseId === undefined ||
        warehouse.warehouseId !== input.destinationWarehouseId,
    );

    if (stockEligible.length === 0) {
      throw new NotFoundException(
        `No warehouse (excluding the destination, if any) has at least ${input.requiredQuantity} available units of product ${input.productId}`,
      );
    }

    const destinationAddress = this.buildAddressString(
      input.deliveryAddress,
      input.deliveryRegion,
      input.deliveryCountry,
    );
    const destinationGeocode =
      await this.geocodingProvider.geocode(destinationAddress);

    const candidates: PathOptimizerCandidate[] = [];
    for (const warehouse of stockEligible) {
      const available = warehouse.items[0].available;

      if (!warehouse.location || !warehouse.location.trim()) {
        candidates.push({
          warehouseId: warehouse.warehouseId,
          warehouseName: warehouse.warehouseName,
          location: warehouse.location,
          available,
          distanceKm: null,
        });
        continue;
      }

      try {
        const warehouseGeocode = await this.geocodingProvider.geocode(
          warehouse.location,
        );
        const distanceKm = this.haversineDistanceKm(
          destinationGeocode.coordinates,
          warehouseGeocode.coordinates,
        );
        candidates.push({
          warehouseId: warehouse.warehouseId,
          warehouseName: warehouse.warehouseName,
          location: warehouse.location,
          available,
          distanceKm,
        });
      } catch {
        candidates.push({
          warehouseId: warehouse.warehouseId,
          warehouseName: warehouse.warehouseName,
          location: warehouse.location,
          available,
          distanceKm: null,
        });
      }
    }

    const withDistance = candidates.filter(
      (
        candidate,
      ): candidate is PathOptimizerCandidate & { distanceKm: number } =>
        candidate.distanceKm !== null,
    );

    if (withDistance.length === 0) {
      throw new NotFoundException(
        'No stock-eligible warehouse location could be geocoded for distance comparison',
      );
    }

    withDistance.sort(
      (a, b) => a.distanceKm - b.distanceKm || a.warehouseId - b.warehouseId,
    );
    const nearest = withDistance[0];

    return {
      productId: input.productId,
      requestedQuantity: input.requiredQuantity,
      destination: {
        deliveryCountry: input.deliveryCountry,
        deliveryRegion: input.deliveryRegion,
        deliveryAddress: input.deliveryAddress,
        formattedAddress: destinationGeocode.formattedAddress,
        coordinates: destinationGeocode.coordinates,
      },
      selectedWarehouseId: nearest.warehouseId,
      selectedWarehouseName: nearest.warehouseName,
      selectedWarehouseLocation: nearest.location,
      availableStockAtSelectedWarehouse: nearest.available,
      distanceKm: nearest.distanceKm,
      consideredCandidates: candidates,
      generatedAt: new Date(),
    };
  }

  private validateInput(input: FindNearestWarehouseInput): void {
    if (!Number.isInteger(input.productId) || input.productId <= 0) {
      throw new BadRequestException(`Invalid productId: ${input.productId}`);
    }
    if (
      !Number.isInteger(input.requiredQuantity) ||
      input.requiredQuantity <= 0
    ) {
      throw new BadRequestException(
        'requiredQuantity must be a positive integer',
      );
    }
    if (
      !input.deliveryAddress?.trim() &&
      !input.deliveryRegion?.trim() &&
      !input.deliveryCountry?.trim()
    ) {
      throw new BadRequestException(
        'At least one of deliveryAddress, deliveryRegion, or deliveryCountry must be provided',
      );
    }
  }

  private buildAddressString(...parts: (string | undefined)[]): string {
    return parts
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(', ');
  }

  private haversineDistanceKm(a: GeoCoordinates, b: GeoCoordinates): number {
    const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
    const dLat = toRadians(b.latitude - a.latitude);
    const dLon = toRadians(b.longitude - a.longitude);
    const lat1 = toRadians(a.latitude);
    const lat2 = toRadians(b.latitude);

    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

    return EARTH_RADIUS_KM * c;
  }
}
