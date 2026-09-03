import { z } from 'zod'

/**
 * Fixed set of allowed product statuses. Using z.enum() (rather than a plain
 * z.string()) rejects typos and out-of-range values instead of silently
 * accepting any string.
 */
export const ProductStatus = z.enum(['draft', 'published', 'archived'])

/**
 * Schema for the untrusted JSON body of `POST /api/products`.
 *
 * - `.strict()` rejects any unrecognized keys instead of silently stripping
 *   them, so a client sending unexpected fields gets a clear 400 instead of
 *   the extra data disappearing unnoticed.
 * - `name` and `price` are required and bounded (non-empty, capped length,
 *   positive finite number) rather than left as unconstrained primitives.
 * - `tags` is genuinely optional (an array of validated strings when
 *   present), not just loosely typed.
 * - `status` is restricted to the three known values via ProductStatus.
 */
export const CreateProductSchema = z
  .object({
    name: z.string().min(1, 'name is required').max(200, 'name is too long'),
    price: z
      .number()
      .finite('price must be a finite number')
      .positive('price must be greater than 0'),
    tags: z.array(z.string().min(1).max(50)).optional(),
    status: ProductStatus,
  })
  .strict()

// Inferred type for use in the route handler — the single source of truth,
// so the type can never drift from the schema.
export type CreateProductInput = z.infer<typeof CreateProductSchema>

/**
 * Validates an untrusted JSON string (e.g. a raw request body) against
 * CreateProductSchema without throwing.
 *
 * JSON.parse() itself can throw on malformed JSON and returns `any` on
 * success, so its output is never trusted directly — it is always run
 * through safeParse() before the caller touches it.
 */
export function parseCreateProductBody(
  rawBody: string
):
  | { success: true; data: CreateProductInput }
  | { success: false; error: string } {
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return { success: false, error: 'Invalid JSON' }
  }

  const result = CreateProductSchema.safeParse(json)
  if (!result.success) {
    return { success: false, error: result.error.issues.map((i) => i.message).join('; ') }
  }

  return { success: true, data: result.data }
}

/*
 * Example Fastify route handler usage:
 *
 * fastify.post('/api/products', async (request, reply) => {
 *   const result = CreateProductSchema.safeParse(request.body)
 *   if (!result.success) {
 *     return reply.status(400).send({
 *       error: 'Validation failed',
 *       issues: result.error.issues,
 *     })
 *   }
 *
 *   const product: CreateProductInput = result.data
 *   // ... persist product
 *   return reply.status(201).send({ product })
 * })
 */
