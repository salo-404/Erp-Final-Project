import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';

import { PathOptimizerModule } from '../src/path-optimizer/path-optimizer.module';
import {
  GEOCODING_PROVIDER,
  GeocodingProvider,
} from '../src/path-optimizer/path-optimizer.service';
import { PrismaService } from '../src/prisma/prisma.service';

const mockGeocoder: GeocodingProvider = {
  async geocode(address: string) {
    const normalized = address.toLowerCase();

    if (normalized.includes('beirut')) {
      return {
        coordinates: {
          latitude: 33.8938,
          longitude: 35.5018,
        },
        formattedAddress: address,
      };
    }

    if (normalized.includes('tripoli')) {
      return {
        coordinates: {
          latitude: 34.4335,
          longitude: 35.8441,
        },
        formattedAddress: address,
      };
    }

    if (normalized.includes('saida')) {
      return {
        coordinates: {
          latitude: 33.5571,
          longitude: 35.3729,
        },
        formattedAddress: address,
      };
    }

    if (normalized.includes('dbayeh')) {
      return {
        coordinates: {
          latitude: 33.9433,
          longitude: 35.59,
        },
        formattedAddress: address,
      };
    }

    return {
      coordinates: {
        latitude: 33.8938,
        longitude: 35.5018,
      },
      formattedAddress: address,
    };
  },
};

describe('Path Optimizer (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let laptopId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PathOptimizerModule],
    })
      .overrideProvider(GEOCODING_PROVIDER)
      .useValue(mockGeocoder)
      .compile();

    app = moduleFixture.createNestApplication();

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();

    prisma = app.get(PrismaService);

    // Find the current seeded Laptop ID automatically.
    // This avoids hard-coding IDs that change after reseeding.
    const laptop = await prisma.product.findFirstOrThrow({
      where: {
        name: 'Laptop Pro 14',
      },
    });

    laptopId = laptop.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('finds the nearest warehouse that can fulfill the requested quantity', async () => {
    const response = await request(app.getHttpServer())
      .post('/path-optimizer/nearest-warehouse')
      .send({
        productId: laptopId,
        requiredQuantity: 5,
        deliveryCountry: 'Lebanon',
        deliveryRegion: 'Mount Lebanon',
        deliveryAddress: 'Dbayeh',
      })
      .expect(201);

    expect(response.body.productId).toBe(laptopId);
    expect(response.body.requestedQuantity).toBe(5);

    expect(response.body.selectedWarehouseId).toBeDefined();
    expect(response.body.selectedWarehouseName).toBeDefined();

    expect(
      response.body.availableStockAtSelectedWarehouse,
    ).toBeGreaterThanOrEqual(5);

    expect(response.body.distanceKm).toBeGreaterThanOrEqual(0);

    expect(Array.isArray(response.body.consideredCandidates)).toBe(true);

    expect(response.body.consideredCandidates.length).toBeGreaterThan(0);

    expect(response.body.destination).toBeDefined();
    expect(response.body.destination.coordinates).toBeDefined();
  });

  it('rejects a request with no delivery location', async () => {
    await request(app.getHttpServer())
      .post('/path-optimizer/nearest-warehouse')
      .send({
        productId: laptopId,
        requiredQuantity: 5,
      })
      .expect(400);
  });

  it('rejects invalid required quantity', async () => {
    await request(app.getHttpServer())
      .post('/path-optimizer/nearest-warehouse')
      .send({
        productId: laptopId,
        requiredQuantity: 0,
        deliveryCountry: 'Lebanon',
        deliveryAddress: 'Dbayeh',
      })
      .expect(400);
  });

  it('returns 404 when no warehouse has enough stock', async () => {
    await request(app.getHttpServer())
      .post('/path-optimizer/nearest-warehouse')
      .send({
        productId: laptopId,
        requiredQuantity: 999999,
        deliveryCountry: 'Lebanon',
        deliveryAddress: 'Dbayeh',
      })
      .expect(404);
  });
});
