import assert from "node:assert/strict";
import test from "node:test";

import {
  PASSWORD_RESET_CODE_SENT_MESSAGE,
  PASSWORD_RESET_CONFIRMATION_ERROR_MESSAGE,
  confirmPasswordResetForUser,
  requestPasswordResetForUser,
} from "../src/auth/passwordResetFlow.ts";

type ForgotCallbacks = {
  onSuccess: (data?: unknown) => void;
  onFailure: (error: Error) => void;
  inputVerificationCode?: (data?: unknown) => void;
};

type ConfirmCallbacks = {
  onSuccess: (result: string) => void;
  onFailure: (error: Error) => void;
};

function fakeUser(overrides: {
  forgotPassword?: (callbacks: ForgotCallbacks) => void;
  confirmPassword?: (code: string, password: string, callbacks: ConfirmCallbacks) => void;
} = {}) {
  return {
    forgotPassword: overrides.forgotPassword ?? ((callbacks: ForgotCallbacks) => callbacks.inputVerificationCode?.()),
    confirmPassword:
      overrides.confirmPassword ??
      ((_code: string, _password: string, callbacks: ConfirmCallbacks) => callbacks.onSuccess("SUCCESS")),
  };
}

test("password reset request resolves when Cognito asks for the verification code", async () => {
  await requestPasswordResetForUser(fakeUser());
  assert.equal(
    PASSWORD_RESET_CODE_SENT_MESSAGE,
    "If an account exists for this email, a verification code will be sent.",
  );
});

test("unknown email is non-enumerating and does not invoke any sign-up operation", async () => {
  const userNotFound = Object.assign(new Error("User does not exist"), {
    name: "UserNotFoundException",
  });
  const user = fakeUser({
    forgotPassword: (callbacks) => callbacks.onFailure(userNotFound),
  });

  await requestPasswordResetForUser(user);
  assert.equal("signUp" in user, false);
});

test("request errors other than an unknown account are preserved", async () => {
  const throttled = Object.assign(new Error("Try again later"), {
    name: "LimitExceededException",
  });
  await assert.rejects(
    requestPasswordResetForUser(
      fakeUser({ forgotPassword: (callbacks) => callbacks.onFailure(throttled) }),
    ),
    /Try again later/,
  );
});

test("confirmation sends the exact code and new password to Cognito", async () => {
  let received: [string, string] | null = null;
  const user = fakeUser({
    confirmPassword: (code, password, callbacks) => {
      received = [code, password];
      callbacks.onSuccess("SUCCESS");
    },
  });

  await confirmPasswordResetForUser(user, "123456", "ValidPass1!");
  assert.deepEqual(received, ["123456", "ValidPass1!"]);
});

test("invalid or expired verification-code errors are preserved", async () => {
  const invalidCode = Object.assign(new Error("Invalid verification code"), {
    name: "CodeMismatchException",
  });
  await assert.rejects(
    confirmPasswordResetForUser(
      fakeUser({ confirmPassword: (_code, _password, callbacks) => callbacks.onFailure(invalidCode) }),
      "000000",
      "ValidPass1!",
    ),
    /Invalid verification code/,
  );
});

test("unknown email is not revealed during confirmation", async () => {
  const userNotFound = Object.assign(new Error("User does not exist"), {
    name: "UserNotFoundException",
  });
  await assert.rejects(
    confirmPasswordResetForUser(
      fakeUser({ confirmPassword: (_code, _password, callbacks) => callbacks.onFailure(userNotFound) }),
      "000000",
      "ValidPass1!",
    ),
    { message: PASSWORD_RESET_CONFIRMATION_ERROR_MESSAGE },
  );
});
