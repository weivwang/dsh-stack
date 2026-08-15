/** Error safe to print without exposing patch or credential contents. */
export class StackError extends Error {
  /** Stable category for CLI and API callers. */
  readonly code: string

  /**
   * Create a public dsh-stack failure.
   * @param code - Stable machine-readable category.
   * @param message - Secret-free user-facing explanation.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'StackError'
    this.code = code
  }
}
