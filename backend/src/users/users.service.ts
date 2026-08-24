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

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cognito: CognitoAdminService,
    private readonly email: EmailService,
  ) {}

  async create(dto: CreateUserDto) {
    const duplicate = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (duplicate) throw new ConflictException('A user with this email already exists');

    let provisioned: {
      cognitoSub: string;
      cognitoUsername: string;
      temporaryPassword: string;
    };
    try {
      provisioned = await this.cognito.createUser({ name: dto.name, email: dto.email });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'UsernameExistsException' || name === 'AliasExistsException') {
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
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
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
    return this.prisma.user.findMany({ select: safeUserSelect });
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

  async update(id: number, dto: UpdateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`User ${id} not found`);
    if (dto.email && dto.email !== existing.email) {
      const duplicate = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (duplicate) throw new ConflictException('A user with this email already exists');
    }

    await this.cognito.updateUser(existing.cognitoUsername, {
      name: dto.name,
      email: dto.email,
    });
    const data: Prisma.UserUpdateInput = {
      name: dto.name,
      email: dto.email,
      role: dto.role,
    };

    try {
      return await this.prisma.user.update({
        where: { id },
        data,
        select: safeUserSelect,
      });
    } catch (error) {
      try {
        await this.cognito.updateUser(existing.cognitoUsername, {
          name: dto.name !== undefined ? existing.name : undefined,
          email: dto.email !== undefined ? existing.email : undefined,
        });
      } catch {
        throw new InternalServerErrorException(
          'User update failed and Cognito attribute rollback requires intervention',
        );
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025') {
          throw new NotFoundException(`User ${id} not found`);
        }
        if (error.code === 'P2002') {
          throw new ConflictException('A user with this email already exists');
        }
      }
      throw error;
    }
  }

  async remove(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { reviewedDocuments: true } } },
    });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    if (user._count.reviewedDocuments > 0) {
      throw new ConflictException('User cannot be deleted because review history exists');
    }

    try {
      await this.prisma.user.delete({ where: { id } });
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
    await this.cognito.deleteUser(user.cognitoUsername);
  }
}
