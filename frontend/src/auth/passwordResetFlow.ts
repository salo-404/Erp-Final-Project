export const PASSWORD_RESET_CODE_SENT_MESSAGE =
  "If an account exists for this email, a verification code will be sent.";
export const PASSWORD_RESET_CONFIRMATION_ERROR_MESSAGE =
  "Unable to reset the password. Check the verification code and try again.";

export interface PasswordResetUser {
  forgotPassword(callbacks: {
    onSuccess: (data: unknown) => void;
    onFailure: (error: Error) => void;
    inputVerificationCode?: (data: unknown) => void;
  }): void;
  confirmPassword(
    verificationCode: string,
    newPassword: string,
    callbacks: {
      onSuccess: (result: string) => void;
      onFailure: (error: Error) => void;
    },
  ): void;
}

/**
 * Starts Cognito's single forgot-password flow. UserNotFoundException is
 * deliberately treated like success so the UI never reveals whether an
 * email is registered. No sign-up/account-creation operation exists here.
 */
export function requestPasswordResetForUser(user: PasswordResetUser): Promise<void> {
  return new Promise((resolve, reject) => {
    user.forgotPassword({
      onSuccess: () => resolve(),
      inputVerificationCode: () => resolve(),
      onFailure: (error) => {
        if (error.name === "UserNotFoundException") {
          resolve();
          return;
        }
        reject(error);
      },
    });
  });
}

export function confirmPasswordResetForUser(
  user: PasswordResetUser,
  verificationCode: string,
  newPassword: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    user.confirmPassword(verificationCode, newPassword, {
      onSuccess: () => resolve(),
      onFailure: (error) => {
        if (error.name === "UserNotFoundException") {
          reject(new Error(PASSWORD_RESET_CONFIRMATION_ERROR_MESSAGE));
          return;
        }
        reject(error);
      },
    });
  });
}
