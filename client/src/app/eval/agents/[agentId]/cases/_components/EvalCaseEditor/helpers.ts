/**
 * AC-79 — pull the failing Zod path out of an `ApiError`'s `details`.
 *
 * The server's 422 envelope carries `error.details`, which is either Fastify's
 * zod-type-provider validation array or a raw `ZodError.issues`. Both are
 * arrays of `{ path, message }`, and both may nest the path under
 * `instancePath`. Anything unrecognised yields `[]` rather than a guess.
 *
 * Pure, so the shape-tolerance is testable without a server.
 */
export function zodPathsFrom(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const out: string[] = [];
  for (const issue of details) {
    if (typeof issue !== "object" || issue === null) continue;
    const rec = issue as { path?: unknown; instancePath?: unknown; message?: unknown };
    const path = Array.isArray(rec.path)
      ? rec.path.join(".")
      : typeof rec.instancePath === "string"
        ? rec.instancePath.replace(/^\//, "").replace(/\//g, ".")
        : "";
    const message = typeof rec.message === "string" ? rec.message : "";
    if (path || message) out.push(path ? `${path}: ${message}`.trim() : message);
  }
  return out;
}
