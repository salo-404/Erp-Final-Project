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

    // Local-dev-only bypass, never active in a real deployment: no Cognito
    // pool needed to run the app locally when one isn't reachable. Real
    // Cognito verification (below) is completely untouched by this - flip
    // LOCAL_AUTH_MODE back off (or unset it) to go straight back to it,
    // nothing about that path was modified.
    if (process.env.LOCAL_AUTH_MODE === 'true') {
      return this.canActivateLocalAuth(token, request);
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
      // client_id is only present on Cognito ACCESS tokens (tokenUse:
      // 'access', which is all CognitoTokenVerifier ever accepts) - it
      // identifies which app client the token was issued to. Comparing it
      // to the service client id, not the User row's role, is what lets
      // AiServiceGuard trust this without a real EMPLOYEE ever being able
      // to reach a service-only route just by sharing that role. Requiring
      // the env var to be non-empty avoids both sides being undefined (an
      // unconfigured deployment) from ever being read as a match.
      const serviceClientId = process.env.COGNITO_SERVICE_APP_CLIENT_ID;
      request.user = {
        ...user,
        isAiService: Boolean(serviceClientId) && payload.client_id === serviceClientId,
      };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid or expired Cognito access token');
    }
  }

  /**
   * LOCAL_AUTH_MODE only - no real Cognito token, no signature, no
   * expiry. The bearer value is literally `local:<seeded user's email>`
   * (see frontend/src/auth/AuthContext.tsx's finishLocalLogin, which
   * mints exactly this string), so the only thing this can do is log in
   * AS a real User row that already exists in the local database - never
   * an arbitrary/invented identity. isAiService is always false here:
   * the AI service concept only matters for the AgentCore-facing
   * SEMANTIC_MATCH_SERVICE_URL/query-database endpoints, and there is no
   * real AI service running in local-auth mode anyway (it needs Bedrock,
   * which needs real AWS credentials independent of this).
   */
  private async canActivateLocalAuth(
    token: string,
    request: Request & { user?: AuthenticatedUser },
  ): Promise<boolean> {
    if (!token.startsWith('local:')) {
      throw new UnauthorizedException('Invalid local dev token');
    }
    const email = token.slice('local:'.length);
    const prisma = this.moduleRef.get(PrismaService, { strict: false });
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, role: true },
    });
    if (!user) {
      throw new UnauthorizedException(
        `No local user with email ${email} - re-run \`npm run seed:app\` and use one of its seeded emails.`,
      );
    }
    request.user = { ...user, isAiService: false };
    return true;
  }
}
