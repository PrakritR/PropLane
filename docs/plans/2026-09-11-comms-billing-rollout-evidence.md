# Communication billing rollout: preparation evidence

September 11 2026. Akhil answered "yea do that" to preparing the separately
bounded billing rollout. This is preparation authority, not production apply
authority. Recovery waiver 2026-09-11-production-recovery-schema is consumed.

Keeper dbb3836e36ec23abd347f16d3eb1b7df7270b015; main/staging source
8ce3868b4e5775661956c6c3f36fcb146bfa931a; production code
2d1353af42c3a652be6cf8a69640468b453f4cea. Fresh remote refs match these values.
The original checkout has unrelated user edits and is untouched. No graph or
legacy graph exists in this keeper; repository documentation is the fallback.

## Fresh metadata-only database inventory

Root queried both targets through pinned Supabase CLI 2.117.0 read-only login
acquisition, private config/cwd and allowlisted environment, then pinned-CA,
hostname-verified pg connections with BEGIN READ ONLY and ROLLBACK. Both commands
exited 0 around 15:20 UTC. No application rows, credentials, SQL error details,
phone numbers or stored payment settings were exported. Counts and schema only:

```json
[
  {
    "target": "production",
    "project": "qahnczmilgptcedaqype",
    "ledgerRows": 176,
    "targetLedger": [],
    "recoveryLedger": [
      {
        "version": "20260911010000",
        "name": "production_recovery_schema"
      }
    ],
    "duplicateNames": [
      "agent_pending_actions"
    ],
    "rowCounts": {
      "manager_comms_billing_accounts": 4,
      "manager_comms_usage_events": 31,
      "manager_automation_settings": 22,
      "sms_outbox": 193
    },
    "preferenceBackfill": {
      "eligible": 0,
      "with_staff_override_key": 0
    },
    "activity": {
      "active": 0,
      "long_transactions": 0,
      "lock_waiters": 0
    },
    "newTablesAbsent": true,
    "existingFunctions": [
      {
        "proname": "spend_sms_segment_budget",
        "arguments": "integer",
        "definition_md5": "05644001a8ce11cca811167876d84075",
        "prosecdef": true,
        "proconfig": [
          "search_path=public, pg_temp"
        ],
        "anon_execute": false,
        "authenticated_execute": false,
        "service_execute": true
      }
    ],
    "existingRecoveryTriggers": [
      {
        "relname": "manager_automation_settings",
        "tgname": "account_recovery_capture_delete",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_capture_delete AFTER DELETE ON public.manager_automation_settings FOR EACH ROW EXECUTE FUNCTION account_recovery_capture_delete()"
      },
      {
        "relname": "manager_automation_settings",
        "tgname": "account_recovery_write_guard",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.manager_automation_settings FOR EACH ROW EXECUTE FUNCTION account_recovery_write_guard()"
      },
      {
        "relname": "manager_comms_billing_accounts",
        "tgname": "account_recovery_capture_delete",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_capture_delete AFTER DELETE ON public.manager_comms_billing_accounts FOR EACH ROW EXECUTE FUNCTION account_recovery_capture_delete()"
      },
      {
        "relname": "manager_comms_billing_accounts",
        "tgname": "account_recovery_write_guard",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.manager_comms_billing_accounts FOR EACH ROW EXECUTE FUNCTION account_recovery_write_guard()"
      },
      {
        "relname": "manager_comms_usage_events",
        "tgname": "account_recovery_capture_delete",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_capture_delete AFTER DELETE ON public.manager_comms_usage_events FOR EACH ROW EXECUTE FUNCTION account_recovery_capture_delete()"
      },
      {
        "relname": "manager_comms_usage_events",
        "tgname": "account_recovery_write_guard",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.manager_comms_usage_events FOR EACH ROW EXECUTE FUNCTION account_recovery_write_guard()"
      },
      {
        "relname": "sms_outbox",
        "tgname": "account_recovery_capture_delete",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_capture_delete AFTER DELETE ON public.sms_outbox FOR EACH ROW EXECUTE FUNCTION account_recovery_capture_delete()"
      },
      {
        "relname": "sms_outbox",
        "tgname": "account_recovery_write_guard",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.sms_outbox FOR EACH ROW EXECUTE FUNCTION account_recovery_write_guard()"
      }
    ],
    "manualPaymentsColumn": {
      "table_name": "manager_automation_settings",
      "column_name": "manual_payments",
      "data_type": "jsonb",
      "is_nullable": "NO",
      "column_default": "'{}'::jsonb"
    }
  },
  {
    "target": "staging",
    "project": "xwszcafaontidfgznlxd",
    "ledgerRows": 187,
    "targetLedger": [],
    "recoveryLedger": [],
    "duplicateNames": [
      "agent_pending_actions",
      "resident_invite_links"
    ],
    "rowCounts": {
      "manager_comms_billing_accounts": 4,
      "manager_comms_usage_events": 31,
      "manager_automation_settings": 23,
      "sms_outbox": 193
    },
    "preferenceBackfill": {
      "eligible": 0,
      "with_staff_override_key": 0
    },
    "activity": {
      "active": 0,
      "long_transactions": 0,
      "lock_waiters": 0
    },
    "newTablesAbsent": true,
    "existingFunctions": [
      {
        "proname": "spend_sms_segment_budget",
        "arguments": "integer",
        "definition_md5": "05644001a8ce11cca811167876d84075",
        "prosecdef": true,
        "proconfig": [
          "search_path=public, pg_temp"
        ],
        "anon_execute": false,
        "authenticated_execute": false,
        "service_execute": true
      }
    ],
    "existingRecoveryTriggers": [
      {
        "relname": "manager_automation_settings",
        "tgname": "account_recovery_capture_delete",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_capture_delete AFTER DELETE ON public.manager_automation_settings FOR EACH ROW EXECUTE FUNCTION account_recovery_capture_delete()"
      },
      {
        "relname": "manager_automation_settings",
        "tgname": "account_recovery_write_guard",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.manager_automation_settings FOR EACH ROW EXECUTE FUNCTION account_recovery_write_guard()"
      },
      {
        "relname": "manager_comms_billing_accounts",
        "tgname": "account_recovery_capture_delete",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_capture_delete AFTER DELETE ON public.manager_comms_billing_accounts FOR EACH ROW EXECUTE FUNCTION account_recovery_capture_delete()"
      },
      {
        "relname": "manager_comms_billing_accounts",
        "tgname": "account_recovery_write_guard",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.manager_comms_billing_accounts FOR EACH ROW EXECUTE FUNCTION account_recovery_write_guard()"
      },
      {
        "relname": "manager_comms_usage_events",
        "tgname": "account_recovery_capture_delete",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_capture_delete AFTER DELETE ON public.manager_comms_usage_events FOR EACH ROW EXECUTE FUNCTION account_recovery_capture_delete()"
      },
      {
        "relname": "manager_comms_usage_events",
        "tgname": "account_recovery_write_guard",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.manager_comms_usage_events FOR EACH ROW EXECUTE FUNCTION account_recovery_write_guard()"
      },
      {
        "relname": "sms_outbox",
        "tgname": "account_recovery_capture_delete",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_capture_delete AFTER DELETE ON public.sms_outbox FOR EACH ROW EXECUTE FUNCTION account_recovery_capture_delete()"
      },
      {
        "relname": "sms_outbox",
        "tgname": "account_recovery_write_guard",
        "tgenabled": "O",
        "definition": "CREATE TRIGGER account_recovery_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.sms_outbox FOR EACH ROW EXECUTE FUNCTION account_recovery_write_guard()"
      }
    ],
    "manualPaymentsColumn": {
      "table_name": "manager_automation_settings",
      "column_name": "manual_payments",
      "data_type": "jsonb",
      "is_nullable": "NO",
      "column_default": "'{}'::jsonb"
    }
  }
]
```

The existing manual_payments column is expected, not proof that the credit
migration was applied. Its IF NOT EXISTS/backfill portion overlaps an older
canonical-column migration. Eligible backfill count is currently zero in both
environments; proposed production operation must fail closed if it changes.

## Source safety finding

The five sources create two account-owned credit history tables AFTER the
one-time recovery trigger loop in 20260907225500_account_recovery_capture.sql.
Pinned main classifies purchases and adjustments in the account purge manifest
and permits their recovery, but no later source attaches write/capture guards.
The global comms_credit_policy singleton is explicitly retained and has no
account ownership. Preparing four triggers on the TWO history tables is the
narrow correction; do not add guards to all tables or change recovery policy.
Local reproduction and independent review are required before calling this fixed.

## Live-code cutover risk

Production code still implements the legacy communication invoicing cron and
helper. It selects unbilled usage without a credit_state filter, gated by
COMMS_PAYG_BILLING_ENABLED. Pinned main retires that cron to a no-op and reuses
the flag for manual checkout. Before any future prepaid traffic, prove the old
invoicer cannot bill prepaid usage, including rollback/old-deployment paths.
No flag value or active invoicing was inferred or changed in this preparation.

Fresh Vercel metadata checks around 15:40 UTC exited 0. Latest production READY
deployment remains dpl_FqzK3oKWGp5cX78haCY1BAh1Zr7T at 2d1353af; latest listed
staging READY remains dpl_DHFznkJpSYESz7pKeXzVrvtoDgUs at 0b6d5679, not the
current staging Git ref. A read-only project environment inventory returned no
COMMS_PAYG_BILLING_ENABLED record. No environment values were persisted, and
this project-setting absence is NOT proof of an existing deployment's captured
runtime flag or proof the old invoicer cannot run. No configuration was changed.

A subsequent read-only GET of `/v13/deployments/dpl_FqzK3oKWGp5cX78haCY1BAh1Zr7T`
also exited 0. Its runtime and build environment inventories each contain 203
string entries, with no exact `COMMS_PAYG_BILLING_ENABLED` key or assignment.
The pinned live `rates.ts` requires this flag's trimmed value to equal `1`;
the live Git tree has no tracked `.env`, `.env.local`, `.env.production` or
`.env.production.local`. These metadata and source checks support the inference
that this particular deployment has PAYG disabled, but do not test its running
cron or certify older rollback deployments. No cron was invoked. Keep the
cutover gate, including a fresh deployment/environment check before release.

Staging deployment, full E2E, application merge conflict and historical parity
remain separate. There was no Twilio, Langfuse, Stripe, Resend, account lifecycle,
production data write, seed, remote migration or deployment in this inventory.
