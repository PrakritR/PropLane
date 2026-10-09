/**
 * An error whose message is safe to show the admin who caused it ("That code already exists").
 * Anything else a route catches is logged server-side and answered with a generic message, so a
 * Stripe or PostgREST error text (schema names, request ids) never reaches the browser.
 */
export class AdminInputError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AdminInputError";
    this.status = status;
  }
}
