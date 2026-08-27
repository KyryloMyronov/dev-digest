/* diff-viewer — unified-diff viewer with optional inline GitHub comments.
   Public surface: the DiffViewer component, the DiffCommentApi contract, and
   the DiffAnnotations overlay (review findings on the diff). */
export { DiffViewer } from "./DiffViewer";
export type { DiffCommentApi } from "./comments";
export type { DiffAnnotation, DiffAnnotations, DiffReveal } from "./annotations";
export { parsePatch } from "./helpers";
