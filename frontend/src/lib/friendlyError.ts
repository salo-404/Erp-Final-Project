import { ApiError } from "./api-client";

// Shown for a genuine server crash (5xx) - the backend's own message there
// is already just NestJS's generic "Internal server error" (no stack trace,
// no detail worth preserving), so replacing it loses nothing and reads better.
const GENERIC_SERVER_ERROR = "Something went wrong on our end. Please try again in a moment.";

// Deliberately narrow: every 4xx ApiError message is written by application
// code specifically for a person to read (e.g. "A user with this email
// already exists", "End date must be after start date") and must pass
// through unchanged - only a 5xx (a real crash, not a business-rule
// rejection) gets rewritten. Anything that isn't even an ApiError (a plain
// thrown Error, a network failure, etc.) uses the caller's own fallback,
// matching every existing call site's prior behavior.
export function friendlyErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.statusCode >= 500 ? GENERIC_SERVER_ERROR : err.message;
  }
  return fallback;
}
