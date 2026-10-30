// SPDX-License-Identifier: Apache-2.0
// Shared error types for the muse-modules package. API routes map
// NotFoundError → 404 and ValidationError → 400.

/** Thrown when a requested module record does not exist. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Thrown when caller input fails module-level validation. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Thrown when an actor attempts an operation reserved for another actor class (e.g. agent dismissing an idea — I-4). */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

/** Map a thrown module error to an HTTP status code. */
export function statusForError(err: unknown): number {
  if (err instanceof NotFoundError) return 404;
  if (err instanceof PermissionError) return 403;
  if (err instanceof ValidationError) return 400;
  return 500;
}

export function messageForError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
