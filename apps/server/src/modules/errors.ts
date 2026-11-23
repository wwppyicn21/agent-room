export type ErrorCode =
  "validation_error" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "internal_error";

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(message: string, code: ErrorCode, statusCode: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "authentication required") {
    super(message, "unauthorized", 401);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, "validation_error", 400);
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, "not_found", 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string) {
    super(message, "forbidden", 403);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, "conflict", 409);
  }
}

export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT_UNIQUE");
}
