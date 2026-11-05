import type { UserKind } from './user-kind.js';

/**
 * The authenticated principal of a request, as seen by business code.
 * Produced by an `AuthStrategy`; read it with `@CurrentUser()`.
 */
export interface AuthUser {
  /** User or staff id. */
  id: string;
  kind: UserKind;
  /** Permission strings, e.g. `wallet`, `bo:users`, `bo:users:modify`. */
  permissions: string[];
  /** Which strategy authenticated the request, e.g. `dev` or `jwt`. */
  strategy: string;
}
