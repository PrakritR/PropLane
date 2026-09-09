# PRP-438 local provider validation

Base `4e81888ef`, keeper `akhil/prp-438-nearby-transit`.

Focused tests: 19 passed, exit 0. TypeScript with 4 GB heap exited 0 before the final constant-only response-cap adjustment; focused tests were rerun afterward and passed. Targeted lint exit code is retained in the coordinator log. Full combined gates remain pending.

Real read-only local lookup at the public reference coordinates 37.78, -122.42 returned five BART stations, beginning with Civic Center at approximately 0.33 straight-line miles. The first bus lookup correctly failed closed because the valid provider response contained 2,537 elements and 1,083,627 bytes, exceeding the original 1 MB cap. After raising the bounded cap to 2 MiB, the same query returned verified mapped bus stops, beginning with McAllister Street & Van Ness Avenue. The active-plus-queued request bound is three, with serialized fetch/body consumption, 10-second request timeout and one-second spacing.

This checks real provider parsing and distance handling. It does not prove an actual listing conversation, geocoding, walking time, service operations, SMS send or handset receipt. No database or messaging transport was used by this provider harness. The local JSON results are retained under ignored `output/`.

Deployed runtimes require explicitly configured HTTPS Nominatim/Overpass services. Public defaults are limited to local development. Caches and rate control are process-local. Configuration and actual leasing-channel QA remain pending before acceptance.
