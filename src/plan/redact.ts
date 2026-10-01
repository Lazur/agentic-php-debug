/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/**
 * Decides which captured values must not leave the debugger.
 *
 * Captures end up in two places an operator does not control: the model's
 * context window and run artifacts on disk. `$_SERVER`, `$_ENV`, config objects
 * and connection objects hand over credentials the moment they are dumped, and
 * "don't print secrets" in a prompt is unenforceable — so this runs as a
 * pipeline stage on every capture instead.
 *
 * Matching is by case-insensitive name fragment, deliberately broad: a
 * redacted `$tokenizer` costs a re-run, a leaked token does not come back.
 */
export class Redactor {
  private readonly pattern: RegExp | null;
  private readonly valueRedactedScopes: Set<string>;

  constructor(names: readonly string[], scopes: readonly string[]) {
    const fragments = names.map((n) => n.trim()).filter((n) => n.length > 0);
    this.pattern =
      fragments.length > 0
        ? new RegExp(fragments.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
        : null;
    this.valueRedactedScopes = new Set(scopes.map((s) => s.toLowerCase()));
  }

  /** True when a variable, property or array key name looks sensitive. */
  isSensitiveName(name: string): boolean {
    return this.pattern !== null && this.pattern.test(name);
  }

  /**
   * True when an evaluate expression reads something sensitive — any
   * identifier, property or string key in it matching a fragment.
   */
  isSensitiveExpression(expr: string): boolean {
    return this.pattern !== null && this.pattern.test(expr);
  }

  /**
   * True when a scope is dumped with names and types only. `$_SERVER`, `$_ENV`
   * and `$_COOKIE` live in Superglobals; seeing which keys exist is useful,
   * their values are exactly what must not leak. One value can still be read
   * with an explicit evaluate, which is name-checked on its own.
   */
  isValueRedactedScope(scopeName: string): boolean {
    return this.valueRedactedScopes.has(scopeName.toLowerCase());
  }
}
