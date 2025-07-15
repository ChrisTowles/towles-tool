import type { Result } from 'neverthrow'
import type { z } from 'zod/v4'
import consola from 'consola'
import { err, ok } from 'neverthrow'
import { AnyError } from '../lib/error'

export class ValidationError<T> extends AnyError {
  override readonly name = 'ValidationError'

  // eslint-disable-next-line node/handle-callback-err
  constructor(
    public readonly error: z.ZodError<T>,
    override readonly message: string,
    cause?: unknown,
  ) {
    super(message, cause)
  }
}

/**
 * Validates data against a schema and returns a Result
 */
export function validate<T extends z.ZodType>(
  schema: T,
  data: unknown,
): Result<z.infer<T>, ValidationError<z.infer<T>>> {
  const result = schema.safeParse(data)

  if (!result.success) {
    consola.error('Validation failed:', result.error)
    return err(new ValidationError(result.error, 'Validation error occurred'))
  }

  return ok(result.data)
}
