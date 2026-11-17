export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const Errors = {
  notFound(message: string): AppError {
    return new AppError(404, 'NOT_FOUND', message)
  },
  forbidden(message: string): AppError {
    return new AppError(403, 'FORBIDDEN', message)
  },
  validation(message: string, details?: unknown): AppError {
    return new AppError(400, 'VALIDATION_ERROR', message, details)
  },
  conflict(message: string): AppError {
    return new AppError(409, 'CONFLICT', message)
  },
  tooMany(message: string): AppError {
    return new AppError(429, 'RATE_LIMITED', message)
  },
}
