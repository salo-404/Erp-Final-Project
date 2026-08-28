import { Injectable } from '@nestjs/common';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

@Injectable()
export class CognitoTokenVerifier {
  private readonly verifier: ReturnType<typeof CognitoJwtVerifier.create>;

  constructor() {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    const clientId = process.env.COGNITO_APP_CLIENT_ID;
    const serviceClientId = process.env.COGNITO_SERVICE_APP_CLIENT_ID;
    if (!userPoolId || !clientId || !serviceClientId) {
      throw new Error(
        'COGNITO_USER_POOL_ID, COGNITO_APP_CLIENT_ID, and COGNITO_SERVICE_APP_CLIENT_ID are required',
      );
    }
    this.verifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'access',
      clientId: [clientId, serviceClientId],
    });
  }

  verify(token: string) {
    return this.verifier.verify(token);
  }
}
