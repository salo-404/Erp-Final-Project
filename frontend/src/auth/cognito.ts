import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import { COGNITO_APP_CLIENT_ID, COGNITO_USER_POOL_ID } from "../lib/env";
import {
  confirmPasswordResetForUser,
  requestPasswordResetForUser,
} from "./passwordResetFlow";

export class CognitoConfigError extends Error {}

function getUserPool(): CognitoUserPool {
  if (!COGNITO_USER_POOL_ID || !COGNITO_APP_CLIENT_ID) {
    throw new CognitoConfigError(
      "Cognito isn't configured (VITE_COGNITO_USER_POOL_ID / VITE_COGNITO_APP_CLIENT_ID missing).",
    );
  }
  return new CognitoUserPool({
    UserPoolId: COGNITO_USER_POOL_ID,
    ClientId: COGNITO_APP_CLIENT_ID,
  });
}

// Decodes the ID token's payload only for its `name` claim, purely for
// immediate post-login UI display — never sent to the backend as a bearer
// (that's always the access token, per ai-agent/README.md and
// cognito-token-verifier.service.ts, which verify tokenUse: "access").
function decodeIdTokenName(idToken: string): string | null {
  try {
    const payload = idToken.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as { name?: string };
    return claims.name ?? null;
  } catch {
    return null;
  }
}

function sessionToResult(session: CognitoUserSession): CognitoSignInSuccess {
  return {
    status: "success",
    accessToken: session.getAccessToken().getJwtToken(),
    name: decodeIdTokenName(session.getIdToken().getJwtToken()),
  };
}

export interface CognitoSignInSuccess {
  status: "success";
  accessToken: string;
  name: string | null;
}

export interface CognitoNewPasswordRequired {
  status: "newPasswordRequired";
  completeNewPassword: (newPassword: string) => Promise<CognitoSignInSuccess>;
}

export type CognitoSignInResult = CognitoSignInSuccess | CognitoNewPasswordRequired;

function passwordResetUser(email: string): CognitoUser {
  return new CognitoUser({ Username: email, Pool: getUserPool() });
}

export function cognitoRequestPasswordReset(email: string): Promise<void> {
  return requestPasswordResetForUser(passwordResetUser(email));
}

export function cognitoConfirmPasswordReset(
  email: string,
  verificationCode: string,
  newPassword: string,
): Promise<void> {
  return confirmPasswordResetForUser(passwordResetUser(email), verificationCode, newPassword);
}

// Cognito's USER_PASSWORD_AUTH flow. The frontend app client must have this
// flow enabled (no client secret). `username` is the work email — the User
// Pool must have email configured as a sign-in alias, since the real
// Cognito username is the opaque erp-<uuid> assigned by
// CognitoAdminService.createUser(), not the email itself.
export function cognitoSignIn(username: string, password: string): Promise<CognitoSignInResult> {
  const pool = getUserPool();
  const cognitoUser = new CognitoUser({ Username: username, Pool: pool });
  const authDetails = new AuthenticationDetails({ Username: username, Password: password });

  return new Promise((resolve, reject) => {
    cognitoUser.authenticateUser(authDetails, {
      onSuccess: (session) => resolve(sessionToResult(session)),
      onFailure: (err) => reject(err),
      newPasswordRequired: () => {
        resolve({
          status: "newPasswordRequired",
          completeNewPassword: (newPassword: string) =>
            new Promise((resolveChallenge, rejectChallenge) => {
              // email/email_verified come back in userAttributes as read-only
              // claims Cognito rejects if resubmitted here; name/email were
              // already set at user creation, so no attributes need resending.
              cognitoUser.completeNewPasswordChallenge(newPassword, {}, {
                onSuccess: (session) => resolveChallenge(sessionToResult(session)),
                onFailure: (err) => rejectChallenge(err),
              });
            }),
        });
      },
    });
  });
}
