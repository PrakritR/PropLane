# Per-room rent basis: monthly vs daily

Moved out of the root `AGENTS.md` to keep it loadable; this is the
authoritative copy. Read it before changing code in this area.

## Per-room rent basis: monthly (default) vs daily

A room can be priced **monthly** (the default, unchanged) or **by the day**. The
model is fully additive — every existing room is monthly and behaves exactly as
before. Three DISTINCT "daily" concepts now coexist; do not conflate them:

- **`rentBasis: "monthly" | "daily"` + `dailyRentPrice`** (new, on
  `ManagerRoomSubmission`) — the room's HEADLINE price and billing basis. This is
  the daily-rent-rate system.
- **`prorateMethod: "auto" | "daily_rate"` + `dailyRentRate`** — proration-only;
  it just prorates the partial edge months of a *monthly* room. Never a headline.
- **`shortTermDailyCost`** — nightly short-term/guest stays. Unrelated.

**Interaction rule (the single tiebreaker).** A room always keeps `monthlyRent`.
`rentBasis` alone decides which rate is active: absent/`"monthly"` → monthly drives
display + every charge (identical to legacy); `"daily"` (requires
`dailyRentPrice > 0`) → the listing shows `$X/day` and every rent charge (first
month, each recurring month, partial last month) bills `billable-days ×
dailyRentPrice` using each month's REAL day count. **Daily never wins unless the
manager explicitly sets `rentBasis = "daily"`**, so monthly rooms are untouched.
Normalization downgrades `rentBasis="daily"` to `"monthly"` when no positive daily
price is set. One exception at charge time: a resident's own negotiated monthly rent
(a `managerRentOverride` or a signed/renewed rent) still beats the room's daily basis,
exactly as it already beats the room's listing monthly rent.

- **Single source of truth:** `src/lib/room-pricing.ts` (`roomIsDailyPriced`,
  `roomHeadlinePriceLabel`, `roomMonthlyEquivalent`, etc.). Use it for any new
  price surface instead of reading `monthlyRent` directly.
- **Aggregate labels** (rent ranges, "starting at", estimated totals, browse-card
  sort/budget) normalize daily rooms to a monthly-equivalent
  (`dailyRentPrice × DAILY_RENT_MONTH_ESTIMATE_DAYS`, 30 days) so mixed listings
  stay coherent as `/mo`; each room's OWN row still shows its true `$X/day`.
- **Charges:** the daily basis threads through `recordApprovedApplicationCharges`
  and the recurring generator via `RecurringRentProfile.dailyRentPrice` in
  `src/lib/household-charges.ts`. It extends the existing daily proration to full
  months — utilities stay monthly.
- Coverage: `tests/unit/room-pricing.test.ts`, `tests/unit/daily-rent-rate.test.ts`,
  `tests/unit/daily-rent-charges.test.ts`, `tests/unit/daily-rent-profile-clear.test.ts`.
