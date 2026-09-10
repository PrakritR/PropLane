# PRP-438 local provider validation

Base `4e81888ef`, keeper `akhil/prp-438-nearby-transit`.

Focused tests: 19 passed, exit 0. TypeScript with 4 GB heap exited 0 before the final constant-only response-cap adjustment; focused tests were rerun afterward and passed. Targeted lint exit code is retained in the coordinator log. Full combined gates remain pending.

Real read-only local lookup at the public reference coordinates 37.78, -122.42 returned five BART stations, beginning with Civic Center at approximately 0.33 straight-line miles. The first bus lookup correctly failed closed because the valid provider response contained 2,537 elements and 1,083,627 bytes, exceeding the original 1 MB cap. After raising the bounded cap to 2 MiB, the same query returned verified mapped bus stops, beginning with McAllister Street & Van Ness Avenue. The active-plus-queued request bound is three, with serialized fetch/body consumption, 10-second request timeout and one-second spacing.

This checks real provider parsing and distance handling. It does not prove an actual listing conversation, geocoding, walking time, service operations, SMS send or handset receipt. No database or messaging transport was used by this provider harness. The local JSON results are retained under ignored `output/`.

An additional read-only dev/test harness used the seeded Cascade Lofts listing (`mgr-demo-cascade`, `1200 Cascade Ave, Seattle, WA 98122`) through the actual leasing tool registry and model. `get_nearby_transit` returned verified OpenStreetMap public-transit facts: five bus stops at approximately 0.07–0.09 straight-line miles, beginning with East Madison Street & 12th Avenue. The BART query returned a verified empty result within the same 3.2 km radius. The model called the tool twice, named the bus stops, correctly said no BART stop was found, and did not invent walking time or service frequency. The harness was read-only and invoked no SMS or email transport; its ignored artifacts are `output/transit-cascade-readonly-qa.{ts,json}`.

Deployed runtimes require explicitly configured HTTPS Nominatim/Overpass services. Public defaults are limited to local development. Caches and rate control are process-local. Configuration and actual leasing-channel QA remain pending before acceptance.
