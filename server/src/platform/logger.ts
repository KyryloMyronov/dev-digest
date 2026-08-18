/**
 * Minimal structured logger (pino-compatible: `(obj, msg)`).
 *
 * Services take one of these rather than importing pino or reaching for
 * `app.log`: the logger is injected at the composition edge, so a service stays
 * callable from a job, a test or the CLI with no Fastify instance in sight.
 *
 * Lives in `platform/` because more than one module needs it — a module-local
 * definition would force a cross-module import to reuse.
 */
export type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
};
