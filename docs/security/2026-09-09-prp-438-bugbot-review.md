# PRP-438 bugbot review

- Reviewed: 2026-09-08T23:19:13-04:00
- Base: 4e81888ef27cbf8ba82abedcc0b0c3e807a94f97
- Uncommitted source diff SHA-256: 2a6a2ece3d2a41f0a35398a4503726edcc87a327248a9e66dc875846da16019b

## Findings

### Travel time is unavailable without a routing provider

The ticket asks for an estimated travel time when available. This implementation has no routing provider, so the prompt correctly forbids deriving walking time from straight-line distance. It must report only approximate straight-line distance; a future provider-backed duration can extend that fact set.

### P1 — deployed environment still needs provider configuration and real leasing QA

With no configured production HTTPS endpoints, every deployed lookup returns unavailable. The local validation used public endpoints and reference coordinates, not a real prospect/listing conversation. Do not mark the real SMS acceptance item complete.

The implementation otherwise correctly bounds response size, request concurrency, in-flight/cache keys, timeouts, malformed/provider failure outcomes, and BART classification evidence. Focused test coverage includes missing address, response failure, oversize bodies, scope, tool contract and prompt grounding. No source edits were made during this review.
