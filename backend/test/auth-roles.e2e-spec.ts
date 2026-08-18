import { Test, TestingModule } from '@nestjs/testing';
import {
  Controller,
  Get,
  INestApplication,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { Roles } from '../src/common/decorators/roles.decorator';
import { UserRole } from '../generated/prisma/client';

@Controller('test-roles')
@UseGuards(JwtAuthGuard, RolesGuard)
class TestRolesController {
  @Get('employee')
  @Roles(UserRole.EMPLOYEE)
  employeeOnly() {
    return {
      ok: true,
      endpoint: 'employee',
    };
  }

  @Get('admin')
  @Roles(UserRole.ADMIN)
  adminOnly() {
    return {
      ok: true,
      endpoint: 'admin',
    };
  }
}

describe('Auth + Roles (e2e)', () => {
  let app: INestApplication;

  let adminToken: string;
  let employeeToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestRolesController],
    }).compile();

    app = moduleFixture.createNestApplication();

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('logs in ADMIN successfully and returns a JWT', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'admin@minierp.com',
        password: 'Password123!',
      })
      .expect(200);

    expect(response.body.access_token).toBeDefined();

    expect(response.body.user).toBeDefined();
    expect(response.body.user.email).toBe('admin@minierp.com');
    expect(response.body.user.role).toBe('ADMIN');

    // Password hashes must never be returned to frontend clients.
    expect(response.body.user.passwordHash).toBeUndefined();

    adminToken = response.body.access_token;
  });

  it('logs in EMPLOYEE successfully and returns a JWT', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'employee@minierp.com',
        password: 'Password123!',
      })
      .expect(200);

    expect(response.body.access_token).toBeDefined();

    expect(response.body.user.email).toBe('employee@minierp.com');
    expect(response.body.user.role).toBe('EMPLOYEE');

    expect(response.body.user.passwordHash).toBeUndefined();

    employeeToken = response.body.access_token;
  });

  it('rejects incorrect credentials', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'admin@minierp.com',
        password: 'wrong-password',
      })
      .expect(401);
  });

  it('rejects protected route without JWT', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('returns authenticated ADMIN identity from JWT', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.id).toBeDefined();
    expect(response.body.email).toBe('admin@minierp.com');
    expect(response.body.role).toBe('ADMIN');
  });

  it('returns authenticated EMPLOYEE identity from JWT', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);

    expect(response.body.id).toBeDefined();
    expect(response.body.email).toBe('employee@minierp.com');
    expect(response.body.role).toBe('EMPLOYEE');
  });

  it('allows EMPLOYEE into EMPLOYEE endpoint', async () => {
    const response = await request(app.getHttpServer())
      .get('/test-roles/employee')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);

    expect(response.body.ok).toBe(true);
  });

  it('allows ADMIN into EMPLOYEE endpoint', async () => {
    const response = await request(app.getHttpServer())
      .get('/test-roles/employee')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.ok).toBe(true);
  });

  it('allows ADMIN into ADMIN-only endpoint', async () => {
    const response = await request(app.getHttpServer())
      .get('/test-roles/admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.ok).toBe(true);
  });

  it('blocks EMPLOYEE from ADMIN-only endpoint', async () => {
    await request(app.getHttpServer())
      .get('/test-roles/admin')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });
});
