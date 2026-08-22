import { ApiError } from './api.js';

/**
 * Claude Code caps MCP tool output at 25k tokens and warns at 10k; Anthropic's
 * own mcp-builder uses this same character constant. Responses that would blow
 * past it are truncated with a hint instead of dumped.
 */
export const CHARACTER_LIMIT = 25_000;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Compact JSON result, hard-capped so one call can never flood the context. */
export function jsonResult(value: unknown, narrowHint?: string): ToolResult {
  let text = JSON.stringify(value);
  if (text.length > CHARACTER_LIMIT) {
    const hint = narrowHint ?? 'narrow the query';
    text = `${text.slice(0, CHARACTER_LIMIT)}\n…truncated at ${CHARACTER_LIMIT} chars — ${hint}.`;
  }
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Wrap a handler so ApiErrors become model-readable isError results. */
export function guarded<A extends unknown[]>(
  fn: (...args: A) => Promise<ToolResult>,
): (...args: A) => Promise<ToolResult> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ApiError) return errorResult(err.message);
      throw err;
    }
  };
}
