import { z } from "zod";

export const productSchema = z.object({
  name: z.string(),
  price: z.number().positive(),
  tags: z.array(z.string()).optional(),
  status: z.enum(["draft", "published", "archived"]),
});

export type Product = z.infer<typeof productSchema>;

/**
 * Safely parses an untrusted JSON string (e.g. a raw Fastify request body)
 * into a validated Product. Never throws — returns a discriminated result
 * so the route handler can respond with 400 on invalid input instead of
 * crashing or relying on try/catch.
 */
export function parseProduct(
  rawBody: string
): { success: true; data: Product } | { success: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { success: false, error: "Invalid JSON" };
  }

  const result = productSchema.safeParse(json);
  if (!result.success) {
    return { success: false, error: result.error.message };
  }

  return { success: true, data: result.data };
}
