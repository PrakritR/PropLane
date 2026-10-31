/**
 * The `mode: "setup"` Checkout session a resident opens to save a card
 * (`/api/stripe/resident-payment-methods`).
 *
 * It owns a `purpose` so the webhook can recognise it by name. Before it did, the session carried
 * no metadata at all, and `isManagerPlanCheckout` classified a purposeless session as a manager
 * plan: a resident saving a card raised `checkout.session.completed` with
 * `payment_status: "no_payment_required"`, entered the manager-plan branch, found no reservation
 * and threw, so the webhook answered Stripe 500 on every retry of that event.
 *
 * Its own module so the client route and the purpose classifier can share it without the route
 * pulling in the server-only Stripe modules the classifier imports.
 */
export const RESIDENT_CARD_SETUP_PURPOSE = "resident_card_setup";
