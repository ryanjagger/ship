/**
 * SqlParam: the union of values the `pg` driver accepts as a query parameter.
 *
 * Use in place of `any[]` for dynamic SQL parameter arrays. Covers the cases
 * actually used across this codebase (string/number/boolean/null/Date/Buffer
 * scalars and the array forms passed to `ANY($1)`).
 */
export type SqlParam =
  | string
  | number
  | boolean
  | null
  | Date
  | Buffer
  | string[]
  | number[];

export type SqlParams = SqlParam[];
