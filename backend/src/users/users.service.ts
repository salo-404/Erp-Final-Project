import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { CognitoAdminService } from '../auth/cognito-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { EmailService } from '../integrations/email/email.service';

const safeUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

// One transaction-scoped PostgreSQL lock protects the cross-row invariant:
// two admins must not concurrently remove each other through demotion/delete.
const ADMIN_MUTATION_LOCK_ID = 742394821;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cognito: CognitoAdminService,
    private readonly email: EmailService,
  ) {}

  async create(dto: CreateUserDto) {
    const duplicate = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (duplicate)
      throw new ConflictException('A user with this email already exists');

    let provisioned: {
      cognitoSub: string;
      cognitoUsername: string;
      temporaryPassword: string;
    };
    try {
      provisioned = await this.cognito.createUser({
        name: dto.name,
        email: dto.email,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (
        name === 'UsernameExistsException' ||
        name === 'AliasExistsException'
      ) {
        throw new ConflictException('A user with this email already exists');
      }
      if (name === 'InvalidParameterException') {
        throw new BadRequestException('Cognito rejected the user attributes');
      }
      throw error;
    }

    let createdUser: Prisma.UserGetPayload<{ select: typeof safeUserSelect }>;
    try {
      createdUser = await this.prisma.user.create({
        data: {
          cognitoSub: provisioned.cognitoSub,
          cognitoUsername: provisioned.cognitoUsername,
          name: dto.name,
          email: dto.email,
          role: dto.role,
        },
        select: safeUserSelect,
      });
    } catch (error) {
      try {
        await this.cognito.deleteUser(provisioned.cognitoUsername);
      } catch {
        throw new InternalServerErrorException(
          'User provisioning failed and Cognito cleanup requires intervention',
        );
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException('A user with this email already exists');
      throw error;
    }

    try {
      await this.email.sendEmail({
        to: dto.email,
        subject: 'Welcome to Nexora / Mini ERP',
        body: [
          'Welcome to Nexora / Mini ERP',
          '',
          'Your account has been created.',
          '',
          `Email: ${dto.email}`,
          `Temporary password: ${provisioned.temporaryPassword}`,
          '',
          'Sign in using these credentials.',
          'On your first login, you will be required to choose a new password.',
        ].join('\n'),
      });
    } catch {
      let cleanupFailed = false;
      try {
        await this.cognito.deleteUser(provisioned.cognitoUsername);
      } catch {
        cleanupFailed = true;
      }
      try {
        await this.prisma.user.delete({ where: { id: createdUser.id } });
      } catch {
        cleanupFailed = true;
      }

      if (cleanupFailed) {
        throw new InternalServerErrorException(
          'Onboarding email failed and user cleanup requires intervention',
        );
      }
      throw new InternalServerErrorException(
        'Onboarding email could not be sent; user creation was rolled back',
      );
    }

    return createdUser;
  }

  findAll() {
    return this.prisma.user.findMany({
      select: safeUserSelect,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: safeUserSelect,
    });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    return user;
  }

  /**
   * Admin Employee Management's ONLY mutation on an existing employee —
   * role, nothing else. UpdateUserDto structurally carries only `role` (no
   * name/email/password/Cognito identity fields), so there is no Cognito
   * call here at all: role is purely a DB-side permission field, never a
   * Cognito user attribute.
   *
   * Blocks demoting the LAST remaining ADMIN away from ADMIN — the same
   * "never end up with zero admins" invariant remove() enforces for
   * deletion, applied to the other way an admin can disappear. Without
   * this, a lone admin (or another admin acting on them) could lock every
   * admin-only capability in the app, including this one, with no way
   * back in.
   */
  async update(id: number, dto: UpdateUserDto) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(${ADMIN_MUTATION_LOCK_ID})`;

        const existing = await tx.user.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException(`User ${id} not found`);

        if (existing.role === 'ADMIN' && dto.role !== 'ADMIN') {
          const otherAdmins = await tx.user.count({
            where: { role: 'ADMIN', id: { not: id } },
          });
          if (otherAdmins === 0) {
            throw new ConflictException(
              'Cannot change the role of the last remaining admin',
            );
          }
        }

        return tx.user.update({
          where: { id },
          data: { role: dto.role },
          select: safeUserSelect,
        });
      },
      { maxWait: 5_000, timeout: 30_000 },
    );
  }

  /**
   * Blocks (in this order, before touching either system):
   *   1. Self-delete — an admin can never delete their own account.
   *   2. Deleting the last remaining ADMIN.
   *   3. A user with review-attribution history (the existing
   *      DocumentReviewer FK, onDelete: Restrict — audit trail is
   *      preserved, never silently dropped).
   *
   * Cognito is deleted BEFORE the PostgreSQL row, deliberately reversed
   * from create()'s Cognito-first-then-Postgres order for the opposite
   * reason: here, Cognito-first is what makes a partial failure land on
   * the SAFE side. Known DB blockers are checked while the User row is
   * locked before Cognito is touched. If an unexpected Postgres failure
   * still occurs afterward, the DB row remains and no history is lost —
   * never the reverse
   * (a Postgres row already gone, JwtAuthGuard would reject the identity,
   * but the orphaned Cognito account would still exist and could still
   * authenticate against Cognito itself). Doing Postgres first would risk
   * exactly that reverse case if the Cognito call then failed.
   */
  async remove(id: number, currentUserId: number) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(${ADMIN_MUTATION_LOCK_ID})`;

        const locked = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM "User" WHERE id = ${id} FOR UPDATE
      `;
        if (locked.length === 0)
          throw new NotFoundException(`User ${id} not found`);

        const user = await tx.user.findUnique({
          where: { id },
          include: { _count: { select: { reviewedDocuments: true } } },
        });
        if (!user) throw new NotFoundException(`User ${id} not found`);

        if (id === currentUserId) {
          throw new BadRequestException('You cannot delete your own account');
        }

        if (user.role === 'ADMIN') {
          const otherAdmins = await tx.user.count({
            where: { role: 'ADMIN', id: { not: id } },
          });
          if (otherAdmins === 0) {
            throw new ConflictException(
              'Cannot delete the last remaining admin',
            );
          }
        }

        if (user._count.reviewedDocuments > 0) {
          throw new ConflictException(
            'User cannot be deleted because review history exists',
          );
        }

        try {
          await this.cognito.deleteUser(user.cognitoUsername);
        } catch (error) {
          const name = error instanceof Error ? error.name : '';
          if (name !== 'UserNotFoundException') {
            throw new InternalServerErrorException(
              'Failed to remove the Cognito identity; the employee was not deleted',
            );
          }
        }

        try {
          return await tx.user.delete({ where: { id } });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError) {
            if (error.code === 'P2025') {
              throw new NotFoundException(`User ${id} not found`);
            }
            if (error.code === 'P2003' || error.code === 'P2014') {
              throw new ConflictException(
                'User cannot be deleted because related records exist',
              );
            }
          }
          throw error;
        }
      },
      { maxWait: 5_000, timeout: 30_000 },
    );
  }
}
