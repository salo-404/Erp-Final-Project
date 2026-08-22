import { Global, Module } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthController } from './auth.controller';
import { CognitoAdminService } from './cognito-admin.service';
import { CognitoTokenVerifier } from './cognito-token-verifier.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [CognitoTokenVerifier, CognitoAdminService, JwtAuthGuard],
  exports: [CognitoTokenVerifier, CognitoAdminService, JwtAuthGuard],
})
export class AuthModule {}
