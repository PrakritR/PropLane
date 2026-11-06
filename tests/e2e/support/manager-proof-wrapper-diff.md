# Proof environment compared with `/tmp/proplane-auth-runtime.mjs`

- The DEV URL, .env.test-over-inherited merge, production-env refusal, 3007 origins, dummy Resend, 6 GiB heap, E2E switch, canonical fixture emails, Twilio/Claw discovery and blanking, pinned Claw destinations, and webpack build command follow the reviewed wrapper.
- The repository working directory replaces the wrapper's fixed absolute cwd. The new runner owns the private capture directory, server lifetime, browser and post-stop cleanup.
- JWT validation is stricter: both credentials must be JWTs and carry the exact DEV ref. The reviewed wrapper only checks the ref when a credential has three segments.
- The runner additionally blanks present Stripe, Checkr, Persona, OpenAI, Anthropic and Meta credentials. It includes product/config/harness and private .env.test/public-environment digests in a build marker, without storing the values.
- The reviewed serve wrapper uses its /tmp preload; this runner uses the repository copy, whose hash is included in the build fingerprint. The runner records allowlisted phases and cleanup status privately rather than inheriting unrestricted child output.
- The runner refuses PostgREST missing-table responses rather than treating them as absent. This is fail-closed even for a genuinely absent table until a catalog-backed exception is added.
