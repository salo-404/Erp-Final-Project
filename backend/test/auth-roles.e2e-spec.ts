import {
  Controller,
  Get,
  INestApplication,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { UserRole } from '../generated/prisma/enums';
import { AuthController } from '../src/auth/auth.controller';
import { CognitoTokenVerifier } from '../src/auth/cognito-token-verifier.service';
import { Roles } from '../src/common/decorators/roles.decorator';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import { UsersController } from '../src/users/users.controller';
import { UsersService } from '../src/users/users.service';

@Controller('test-role')
@UseGuards(JwtAuthGuard, RolesGuard)
class TestRoleController {
  @Get('admin')
  @Roles(UserRole.ADMIN)
  adminOnly() {
    return { ok: true };
  }
}

describe('Cognito authentication and database roles (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const verifier = {
      verify: jest.fn(async (token: string) => {
        if (token === 'invalid') throw new Error('bad signature');
        return { sub: token };
      }),
    };
    const users = new Map([
      ['admin-sub', { id: 1, email: 'admin@example.com', role: UserRole.ADMIN }],
      ['employee-sub', { id: 2, email: 'employee@example.com', role: UserRole.EMPLOYEE }],
    ]);
    const prisma = {
      user: { findUnique: jest.fn(({ where }) => users.get(where.cognitoSub) ?? null) },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, TestRoleController, UsersController],
      providers: [
        JwtAuthGuard,
        RolesGuard,
        Reflector,
        { provide: CognitoTokenVerifier, useValue: verifier },
        { provide: PrismaService, useValue: prisma },
        {
          provide: UsersService,
          useValue: {
            create: jest.fn(async (dto) => ({ id: 3, ...dto })),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => app.close());

  it('removes the custom login route', () =>
    request(app.getHttpServer()).post('/auth/login').send({}).expect(404));

  it('returns the mapped ERP profile from /auth/me', () =>
    request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer admin-sub')
      .expect(200)
      .expect({ id: 1, email: 'admin@example.com', role: UserRole.ADMIN }));

  it('allows a mapped ADMIN through ADMIN authorization', () =>
    request(app.getHttpServer())
      .get('/test-role/admin')
      .set('Authorization', 'Bearer admin-sub')
      .expect(200));

  it('rejects a mapped EMPLOYEE from ADMIN authorization', () =>
    request(app.getHttpServer())
      .get('/test-role/admin')
      .set('Authorization', 'Bearer employee-sub')
      .expect(403));

  it('rejects invalid and unmapped Cognito tokens', async () => {
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer unmapped-sub')
      .expect(401);
  });

  it('POST /users requires no password and rejects the retired password field', async () => {
    const payload = { name: 'Provisioned', email: 'new@example.com', role: UserRole.EMPLOYEE };
    await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', 'Bearer admin-sub')
      .send(payload)
      .expect(201);
    await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', 'Bearer admin-sub')
      .send({ ...payload, password: 'retired-password' })
      .expect(400);
  });
});
