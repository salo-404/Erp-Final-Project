import assert from "node:assert/strict";
import test from "node:test";

import { getNewPasswordValidationError } from "../src/auth/passwordPolicy.ts";

test("accepts a Cognito-style policy-compliant password", () => {
  assert.equal(getNewPasswordValidationError("ValidPass1!"), null);
});

test("rejects empty, short, and missing-character-class passwords locally", () => {
  assert.match(getNewPasswordValidationError("") ?? "", /enter/i);
  assert.match(getNewPasswordValidationError("Aa1!") ?? "", /8 characters/i);
  assert.match(getNewPasswordValidationError("PASSWORD1!") ?? "", /lowercase/i);
  assert.match(getNewPasswordValidationError("password1!") ?? "", /uppercase/i);
  assert.match(getNewPasswordValidationError("Password!") ?? "", /number/i);
  assert.match(getNewPasswordValidationError("Password1") ?? "", /symbol/i);
});
