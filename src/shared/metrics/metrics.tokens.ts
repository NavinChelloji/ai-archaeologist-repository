/**
 * Kept in their own file, separate from `metrics.module.ts` and
 * `metrics.controller.ts` — those two import from each other (the module
 * declares the controller, the controller needs these tokens), and having
 * the tokens live in either of them creates a circular import where
 * `@Inject(TOKEN)` captures `undefined` at decorator-evaluation time (the
 * classic "Nest can't resolve dependencies ... argument is undefined at
 * runtime" trap). Neither file importing the other breaks the cycle.
 */
export const METRICS_REGISTRY = Symbol("METRICS_REGISTRY");
export const HTTP_METRICS = Symbol("HTTP_METRICS");
export const QUEUE_METRICS = Symbol("QUEUE_METRICS");
export const STAGE_METRICS = Symbol("STAGE_METRICS");
