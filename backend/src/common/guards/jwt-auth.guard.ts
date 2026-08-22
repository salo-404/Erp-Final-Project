import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ModuleRef } from '@nestjs/core';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { CognitoTokenVerifier } from '../../auth/cognito-token-verifier.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly moduleRef: ModuleRef,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const authorization = request.headers.authorization;
    const [scheme, token] = authorization?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('A valid Cognito access token is required');
    }

    try {
      const verifier = this.moduleRef.get(CognitoTokenVerifier, { strict: false });
      const prisma = this.moduleRef.get(PrismaService, { strict: false });
      const payload = await verifier.verify(token);
      if (!payload.sub) {
        throw new UnauthorizedException('Cognito token has no subject');
      }
      const user = await prisma.user.findUnique({
        where: { cognitoSub: payload.sub },
        select: { id: true, email: true, role: true },
      });
      if (!user) {
        throw new UnauthorizedException('Cognito identity is not mapped to an ERP user');
      }
      request.user = user;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid or expired Cognito access token');
    }
  }
}
