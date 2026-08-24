import { ConflictException } from '@nestjs/common';
import { AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { UserRole } from '../../generated/prisma/enums';
import { CognitoAdminService } from '../auth/cognito-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';
import { EmailService } from '../integrations/email/email.service';

describe('UsersService Cognito provisioning', () => {
  const dto = { name: 'New User', email: 'new@example.com', role: UserRole.EMPLOYEE };

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

    expect(cognito.createUser).toHaveBeenCalledWith({ name: dto.name, email: dto.email });
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
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 3,
          cognitoUsername: 'reviewer',
          _count: { reviewedDocuments: 1 },
        }),
        delete: jest.fn(),
      },
    };
    const cognito = { deleteUser: jest.fn() };
    const email = { sendEmail: jest.fn() };
    const service = new UsersService(
      prisma as unknown as PrismaService,
      cognito as unknown as CognitoAdminService,
      email as unknown as EmailService,
    );
    await expect(service.remove(3)).rejects.toBeInstanceOf(ConflictException);
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
