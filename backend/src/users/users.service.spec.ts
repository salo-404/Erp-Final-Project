import { BadRequestException, ConflictException } from '@nestjs/common';
import { AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { Prisma } from '../../generated/prisma/client';
import { UserRole } from '../../generated/prisma/enums';
import { CognitoAdminService } from '../auth/cognito-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';
import { EmailService } from '../integrations/email/email.service';

describe('UsersService Cognito provisioning', () => {
  const dto = {
    name: 'New User',
    email: 'new@example.com',
    role: UserRole.EMPLOYEE,
  };

  it('creates Cognito first and stores its stable identifiers in PostgreSQL', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 1, ...dto }),
      },
    };
    const cognito = {
      createUser: jest.fn().mockResolvedValue({
        cognitoSub: 'sub-1',
        cognitoUsername: 'erp-stable-1',
        temporaryPassword: 'Aa1!temporary-password',
      }),
      deleteUser: jest.fn(),
    };
    const email = { sendEmail: jest.fn().mockResolvedValue({ success: true }) };
    const service = new UsersService(
      prisma as unknown as PrismaService,
      cognito as unknown as CognitoAdminService,
      email as unknown as EmailService,
    );

    await service.create(dto);

    expect(cognito.createUser).toHaveBeenCalledWith({
      name: dto.name,
      email: dto.email,
    });
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cognitoSub: 'sub-1',
          cognitoUsername: 'erp-stable-1',
          name: dto.name,
          email: dto.email,
          role: dto.role,
        }),
      }),
    );
    expect(prisma.user.create.mock.calls[0][0].data).not.toHaveProperty(
      'temporaryPassword',
    );
    expect(email.sendEmail).toHaveBeenCalledWith({
      to: dto.email,
      subject: 'Welcome to Nexora / Mini ERP',
      body: expect.stringContaining(
        'Temporary password: Aa1!temporary-password',
      ),
    });
  });

  it('maps a Cognito duplicate to Conflict', async () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(null) } };
    const duplicate = Object.assign(new Error('duplicate'), {
      name: 'UsernameExistsException',
    });
    const cognito = { createUser: jest.fn().mockRejectedValue(duplicate) };
    const email = { sendEmail: jest.fn() };
    const service = new UsersService(
      prisma as unknown as PrismaService,
      cognito as unknown as CognitoAdminService,
      email as unknown as EmailService,
    );
    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('compensates Cognito creation when PostgreSQL creation fails', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(new Error('database unavailable')),
      },
    };
    const cognito = {
      createUser: jest.fn().mockResolvedValue({
        cognitoSub: 'sub-2',
        cognitoUsername: 'erp-stable-2',
        temporaryPassword: 'Aa1!temporary-password',
      }),
      deleteUser: jest.fn().mockResolvedValue(undefined),
    };
    const email = { sendEmail: jest.fn() };
    const service = new UsersService(
      prisma as unknown as PrismaService,
      cognito as unknown as CognitoAdminService,
      email as unknown as EmailService,
    );
    await expect(service.create(dto)).rejects.toThrow('database unavailable');
    expect(cognito.deleteUser).toHaveBeenCalledWith('erp-stable-2');
  });

  it('blocks deletion before Cognito when review attribution exists', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 3 }]),
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 3,
          role: UserRole.EMPLOYEE,
          cognitoUsername: 'reviewer',
          _count: { reviewedDocuments: 1 },
        }),
        count: jest.fn(),
        delete: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    const cognito = { deleteUser: jest.fn() };
    const email = { sendEmail: jest.fn() };
    const service = new UsersService(
      prisma as unknown as PrismaService,
      cognito as unknown as CognitoAdminService,
      email as unknown as EmailService,
    );
    // Different id than the acting admin (99) — not a self-delete case.
    await expect(service.remove(3, 99)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(cognito.deleteUser).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('rolls back Cognito and PostgreSQL when onboarding email delivery fails', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 9, ...dto }),
        delete: jest.fn().mockResolvedValue({ id: 9 }),
      },
    };
    const cognito = {
      createUser: jest.fn().mockResolvedValue({
        cognitoSub: 'sub-9',
        cognitoUsername: 'erp-stable-9',
        temporaryPassword: 'Aa1!temporary-password',
      }),
      deleteUser: jest.fn().mockResolvedValue(undefined),
    };
    const email = {
      sendEmail: jest.fn().mockRejectedValue(new Error('Gmail unavailable')),
    };
    const service = new UsersService(
      prisma as unknown as PrismaService,
      cognito as unknown as CognitoAdminService,
      email as unknown as EmailService,
    );

    await expect(service.create(dto)).rejects.toThrow(
      'Onboarding email could not be sent; user creation was rolled back',
    );
    expect(cognito.deleteUser).toHaveBeenCalledWith('erp-stable-9');
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 9 } });
  });
});

describe('UsersService admin employee management', () => {
  function buildService(
    overrides: {
      findUnique?: jest.Mock;
      count?: jest.Mock;
      update?: jest.Mock;
      findMany?: jest.Mock;
      deleteUser?: jest.Mock;
      deleteMock?: jest.Mock;
      queryRaw?: jest.Mock;
    } = {},
  ) {
    const prisma = {
      $queryRaw: overrides.queryRaw ?? jest.fn().mockResolvedValue([{ id: 1 }]),
      user: {
        findUnique: overrides.findUnique ?? jest.fn(),
        count: overrides.count ?? jest.fn().mockResolvedValue(0),
        update: overrides.update ?? jest.fn(),
        findMany: overrides.findMany ?? jest.fn(),
        delete: overrides.deleteMock ?? jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    const cognito = {
      deleteUser:
        overrides.deleteUser ?? jest.fn().mockResolvedValue(undefined),
    };
    const email = { sendEmail: jest.fn() };
    const service = new UsersService(
      prisma as unknown as PrismaService,
      cognito as unknown as CognitoAdminService,
      email as unknown as EmailService,
    );
    return { service, prisma, cognito, email };
  }

  it('admin list: findAll returns only the safe fields, ordered by name', async () => {
    const expected = [
      {
        id: 2,
        name: 'Bea',
        email: 'bea@example.com',
        role: UserRole.EMPLOYEE,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const findMany = jest.fn().mockResolvedValue(expected);
    const { service, prisma } = buildService({ findMany });

    const result = await service.findAll();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { name: 'asc' },
    });
    expect(result).toEqual(expected);
    // Never leaks cognitoSub/cognitoUsername — the select object itself proves it, no field named either.
    expect(
      Object.keys(prisma.user.findMany.mock.calls[0][0].select),
    ).not.toContain('cognitoSub');
  });

  it('role change: update() changes only role, never touches Cognito', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValue({ id: 5, role: UserRole.EMPLOYEE });
    const update = jest.fn().mockResolvedValue({ id: 5, role: UserRole.ADMIN });
    const { service, prisma, cognito } = buildService({ findUnique, update });

    const result = await service.update(5, { role: UserRole.ADMIN });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { role: UserRole.ADMIN },
      select: expect.any(Object),
    });
    expect(cognito.deleteUser).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 5, role: UserRole.ADMIN });
  });

  it('role change: blocks demoting the last remaining admin', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValue({ id: 5, role: UserRole.ADMIN });
    const count = jest.fn().mockResolvedValue(0); // no OTHER admins besides id 5
    const update = jest.fn();
    const { service, prisma } = buildService({ findUnique, count, update });

    await expect(
      service.update(5, { role: UserRole.EMPLOYEE }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { role: 'ADMIN', id: { not: 5 } },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('role change: allows demoting an admin when another admin still exists', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValue({ id: 5, role: UserRole.ADMIN });
    const count = jest.fn().mockResolvedValue(1); // one other admin exists
    const update = jest
      .fn()
      .mockResolvedValue({ id: 5, role: UserRole.EMPLOYEE });
    const { service } = buildService({ findUnique, count, update });

    await expect(
      service.update(5, { role: UserRole.EMPLOYEE }),
    ).resolves.toEqual({
      id: 5,
      role: UserRole.EMPLOYEE,
    });
  });

  it('self-delete blocked: an admin cannot delete their own account', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: 7,
      role: UserRole.ADMIN,
      cognitoUsername: 'erp-7',
      _count: { reviewedDocuments: 0 },
    });
    const { service, prisma, cognito } = buildService({ findUnique });

    await expect(service.remove(7, 7)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(cognito.deleteUser).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('last-admin deletion blocked: cannot delete the only remaining admin, even by a different admin', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: 3,
      role: UserRole.ADMIN,
      cognitoUsername: 'erp-3',
      _count: { reviewedDocuments: 0 },
    });
    const count = jest.fn().mockResolvedValue(0); // no other admins
    const { service, prisma, cognito } = buildService({ findUnique, count });

    // Acting admin (99) is different from the target (3) — a genuine
    // other-admin deletion attempt, not the self-delete case.
    await expect(service.remove(3, 99)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { role: 'ADMIN', id: { not: 3 } },
    });
    expect(cognito.deleteUser).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('normal delete: removes Cognito BEFORE the database row, in that order', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: 11,
      role: UserRole.EMPLOYEE,
      cognitoUsername: 'erp-11',
      _count: { reviewedDocuments: 0 },
    });
    const callOrder: string[] = [];
    const deleteUser = jest.fn().mockImplementation(async () => {
      callOrder.push('cognito');
    });
    const deleteMock = jest.fn().mockImplementation(async () => {
      callOrder.push('db');
    });
    const { service } = buildService({ findUnique, deleteUser, deleteMock });

    await service.remove(11, 99);

    expect(callOrder).toEqual(['cognito', 'db']);
  });

  it('normal delete: a Cognito failure blocks the database delete entirely (never an orphaned, still-authenticatable Cognito account)', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: 11,
      role: UserRole.EMPLOYEE,
      cognitoUsername: 'erp-11',
      _count: { reviewedDocuments: 0 },
    });
    const deleteUser = jest
      .fn()
      .mockRejectedValue(new Error('Cognito unavailable'));
    const { service, prisma } = buildService({ findUnique, deleteUser });

    await expect(service.remove(11, 99)).rejects.toThrow(
      'Failed to remove the Cognito identity; the employee was not deleted',
    );
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('normal delete: a Cognito UserNotFoundException (already gone — e.g. a retry) still proceeds to remove the DB row', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: 11,
      role: UserRole.EMPLOYEE,
      cognitoUsername: 'erp-11',
      _count: { reviewedDocuments: 0 },
    });
    const alreadyGone = Object.assign(new Error('not found'), {
      name: 'UserNotFoundException',
    });
    const deleteUser = jest.fn().mockRejectedValue(alreadyGone);
    const { service, prisma } = buildService({ findUnique, deleteUser });

    await service.remove(11, 99);

    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 11 } });
  });

  it('related-record delete conflict: a race that only surfaces at the database level (P2003) still returns a clear Conflict, not a raw Prisma error', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: 11,
      role: UserRole.EMPLOYEE,
      cognitoUsername: 'erp-11',
      _count: { reviewedDocuments: 0 }, // pre-check saw none...
    });
    const prismaError = Object.assign(new Error('FK violation'), {
      code: 'P2003',
      name: 'PrismaClientKnownRequestError',
    });
    Object.setPrototypeOf(
      prismaError,
      Prisma.PrismaClientKnownRequestError.prototype,
    );
    const deleteMock = jest.fn().mockRejectedValue(prismaError); // ...but one appeared before the delete committed
    const { service } = buildService({ findUnique, deleteMock });

    await expect(service.remove(11, 99)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('serializes concurrent cross-demotions so exactly one admin remains', async () => {
    const roles = new Map<number, UserRole>([
      [1, UserRole.ADMIN],
      [2, UserRole.ADMIN],
    ]);
    let queue = Promise.resolve();
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      user: {
        findUnique: jest.fn(async ({ where }) => {
          const role = roles.get(where.id);
          return role ? { id: where.id, role } : null;
        }),
        count: jest.fn(
          async ({ where }) =>
            [...roles].filter(
              ([id, role]) => role === UserRole.ADMIN && id !== where.id.not,
            ).length,
        ),
        update: jest.fn(async ({ where, data }) => {
          roles.set(where.id, data.role);
          return { id: where.id, role: data.role };
        }),
      },
    };
    prisma.$transaction = jest.fn(async (callback) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(prisma);
      } finally {
        release();
      }
    });
    const service = new UsersService(
      prisma as PrismaService,
      { deleteUser: jest.fn() } as unknown as CognitoAdminService,
      { sendEmail: jest.fn() } as unknown as EmailService,
    );

    const results = await Promise.allSettled([
      service.update(1, { role: UserRole.EMPLOYEE }),
      service.update(2, { role: UserRole.EMPLOYEE }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      [...roles.values()].filter((role) => role === UserRole.ADMIN),
    ).toHaveLength(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent cross-deletes so exactly one admin remains', async () => {
    const users = new Map([
      [1, { id: 1, role: UserRole.ADMIN, cognitoUsername: 'admin-1' }],
      [2, { id: 2, role: UserRole.ADMIN, cognitoUsername: 'admin-2' }],
    ]);
    let queue = Promise.resolve();
    const queryRaw = jest.fn(
      async (strings: TemplateStringsArray, value: number) =>
        strings[0].includes('FROM "User"') && users.has(value)
          ? [{ id: value }]
          : [],
    );
    const prisma: any = {
      $queryRaw: queryRaw,
      user: {
        findUnique: jest.fn(async ({ where }) => {
          const user = users.get(where.id);
          return user ? { ...user, _count: { reviewedDocuments: 0 } } : null;
        }),
        count: jest.fn(
          async ({ where }) =>
            [...users.values()].filter(
              (user) =>
                user.role === UserRole.ADMIN && user.id !== where.id.not,
            ).length,
        ),
        delete: jest.fn(async ({ where }) => {
          const user = users.get(where.id);
          users.delete(where.id);
          return user;
        }),
      },
    };
    prisma.$transaction = jest.fn(async (callback) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(prisma);
      } finally {
        release();
      }
    });
    const cognito = { deleteUser: jest.fn().mockResolvedValue(undefined) };
    const service = new UsersService(
      prisma as PrismaService,
      cognito as unknown as CognitoAdminService,
      { sendEmail: jest.fn() } as unknown as EmailService,
    );

    const results = await Promise.allSettled([
      service.remove(2, 1),
      service.remove(1, 2),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      [...users.values()].filter((user) => user.role === UserRole.ADMIN),
    ).toHaveLength(1);
    expect(cognito.deleteUser).toHaveBeenCalledTimes(1);
  });
});

describe('CognitoAdminService', () => {
  it('uses AdminCreateUser with a secure temporary password, suppressed native delivery, and stable attributes', async () => {
    process.env.COGNITO_USER_POOL_ID = 'pool-1';
    const service = new CognitoAdminService();
    const send = jest.fn().mockResolvedValue({
      User: {
        Username: 'erp-stable',
        Attributes: [{ Name: 'sub', Value: 'sub-stable' }],
      },
    });
    Object.assign(service as object, { client: { send } });

    const result = await service.createUser({
      name: 'Invited User',
      email: 'invited@example.com',
    });
    expect(result).toEqual({
      cognitoSub: 'sub-stable',
      cognitoUsername: 'erp-stable',
      temporaryPassword: expect.any(String),
    });
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(AdminCreateUserCommand);
    expect(command.input).toEqual(
      expect.objectContaining({
        UserPoolId: 'pool-1',
        MessageAction: 'SUPPRESS',
        TemporaryPassword: result.temporaryPassword,
        UserAttributes: [
          { Name: 'email', Value: 'invited@example.com' },
          { Name: 'name', Value: 'Invited User' },
          { Name: 'email_verified', Value: 'true' },
        ],
      }),
    );
    expect(command.input.Username).toMatch(/^erp-/);
    expect(result.temporaryPassword).toMatch(/[a-z]/);
    expect(result.temporaryPassword).toMatch(/[A-Z]/);
    expect(result.temporaryPassword).toMatch(/\d/);
    expect(result.temporaryPassword).toMatch(/[^A-Za-z0-9]/);
    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(20);
  });
});
