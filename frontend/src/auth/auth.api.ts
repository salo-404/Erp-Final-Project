import { apiRequest } from "../lib/api-client";
import {
  cognitoConfirmPasswordReset,
  cognitoRequestPasswordReset,
  cognitoSignIn,
  type CognitoSignInResult,
} from "./cognito";
import type { AuthenticatedIdentity } from "../types/api";

// Sign-in now goes directly to Cognito (backend/src/auth/auth.controller.ts
// no longer has a /login route — CognitoTokenVerifier validates the access
// token this returns). Callers get back either a ready access token or a
// newPasswordRequired challenge (temp passwords from CognitoAdminService.createUser()).
export function login(email: string, password: string): Promise<CognitoSignInResult> {
  return cognitoSignIn(email, password);
}

export function requestPasswordReset(email: string): Promise<void> {
  return cognitoRequestPasswordReset(email);
}

export function confirmPasswordReset(
  email: string,
  verificationCode: string,
  newPassword: string,
): Promise<void> {
  return cognitoConfirmPasswordReset(email, verificationCode, newPassword);
}

export function fetchCurrentIdentity(): Promise<AuthenticatedIdentity> {
  return apiRequest<AuthenticatedIdentity>("/auth/me");
}
