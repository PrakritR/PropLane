# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Property managers and owners operate portfolios, leasing, tenancy, services, communications, finances, documents, and team access from the manager portal.
- Residents apply, schedule tours, manage leases and payments, request services, access household information and documents, and communicate with managers.
- Vendors manage assigned work, schedules, communications, invoices, payments, compliance documents, and profile information.
- Internal administrators manage platform accounts, properties, meetings, feedback, and communication operations.

## Product Purpose

PropLane is a property-management platform that keeps the operational work of leasing and running rental housing in one connected system. Success means each role can understand what needs attention, find the relevant record, and complete the next permitted action accurately with minimal friction.

## Positioning

PropLane combines role-specific portals with one permission-scoped tool layer. The normal interface and the built-in assistant use the same capabilities, while every state-changing assistant action remains previewed, explicitly confirmed, and auditable.

## Operating Context

- Managers work across high-frequency queues and long-lived records: properties, tours, applications, leases, residents, charges, service work, schedules, messages, promotions, financial reports, documents, and collaborators.
- Users frequently filter, search, compare statuses, review detail records, select multiple rows, and act on one or more records.
- The same deployed Next.js website is loaded by the Capacitor iOS and Android shells. Website design is the first phase; native-shell and WebView optimization is a separate second phase.
- Real interfaces include empty, loading, error, disabled, permission-gated, long-text, high-count, and dense-data states.

## Capabilities and Constraints

- Existing route behavior, product terminology, data models, role boundaries, confirmation gates, analytics, and observability must remain intact during visual redesign.
- Portal UI changes must continue to satisfy the project’s web/native route and navigation parity checks.
- Public listing surfaces must never fabricate property photography. Photo-less production listings use the shared no-image placeholder.
- Supabase egress is constrained; visual changes must not introduce unnecessary refetching or bypass existing cache and coalescing behavior.
- Meaningful interactive elements use the project’s `data-attr` convention. Funnel events reuse established PostHog names and never carry PII.
- The implementation uses Next.js 16, React 19, Tailwind CSS 4, Radix primitives, Lucide icons, Vaul drawers, and shared portal components.

## Brand Commitments

- The product name shown to users is PropLane.
- The current Blue Steel identity, cobalt accent, PropLane mark, light data-oriented portals, and restrained premium character remain recognizable; this project is an operational UI redesign, not a rebrand.
- Dense work surfaces remain calm and legible. Animated or decorative chrome is reserved for established marquee contexts.
- Destructive actions remain visually quiet and require clear intent.

## Evidence on Hand

- Production interface and component guidance in `docs/DESIGN.md`, `docs/portal-ui-system.md`, and `docs/portal-list-section-layout.md`.
- Real seeded manager, resident, vendor, and admin records used by the test environment.
- Route-by-route desktop and responsive audit screenshots under `output/design-audit/`.
- Automated accessibility results from representative portal, detail, public, and authentication pages.
- Existing property imagery and explicit no-image placeholders; no substitute stock imagery may be invented.

## Product Principles

1. Make the next operational decision obvious without hiding context.
2. Use one coherent interaction language across roles while respecting each role’s task density and permissions.
3. Progressive disclosure should reduce noise, not make essential states or actions undiscoverable.
4. Preserve factual integrity: records, amounts, dates, statuses, and property imagery are grounded in real system data.
5. Accessibility, responsive behavior, performance, analytics, and web/native parity are shipping requirements.

## Accessibility & Inclusion

The website targets WCAG 2.2 AA behavior: semantic controls, keyboard access, visible focus, meaningful labels and states, sufficient contrast, reduced-motion support, scalable text, and touch targets of at least 44 CSS pixels for primary interactions.
