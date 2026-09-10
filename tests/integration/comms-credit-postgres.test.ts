import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

// Dedicated disposable local PostgreSQL only. Bootstrap with the billing and credit migrations.
const url = process.env.COMMS_CREDIT_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw new Error(
    "Credit concurrency tests require a disposable local database.",
  );
const db = new Pool({ connectionString: url, max: 12 });
afterAll(() => db.end());
const suite = url ? describe : describe.skip;
async function owner() {
  const id = randomUUID();
  await db.query("insert into profiles(id) values($1)", [id]);
  return id;
}
async function snapshot(id: string, allowance = 200, apply = false) {
  return (
    await db.query("select comms_wallet_snapshot($1,$2,250,$3) as result", [
      id,
      allowance,
      apply,
    ])
  ).rows[0].result;
}
async function reserve(
  id: string,
  key = randomUUID(),
  quantity = 1,
  unfunded = false,
) {
  return (
    await db.query(
      "select reserve_comms_credit($1,200,250,$2,'sms_outbound_segment',$3,3,'{}',$4) as result",
      [id, key, quantity, unfunded],
    )
  ).rows[0].result;
}
suite("atomic prepaid communication ledger", () => {
  it("never creates an account during a balance GET", async () => {
    const id = await owner();
    expect((await snapshot(id)).included_remaining_cents).toBe(200);
    expect(
      (
        await db.query(
          "select 1 from manager_comms_billing_accounts where manager_user_id=$1",
          [id],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("concurrent SMS cannot overspend Free credit and a card does not bypass it", async () => {
    const id = await owner();
    await snapshot(id, 200, true);
    await db.query(
      "update manager_comms_billing_accounts set has_default_payment_method=true where manager_user_id=$1",
      [id],
    );
    const attempts = await Promise.all(
      Array.from({ length: 80 }, () => reserve(id)),
    );
    expect(attempts.filter((r) => r.allowed)).toHaveLength(66);
    expect((await snapshot(id)).included_remaining_cents).toBe(2);
  });
  it("deduplicates usage and rejects a cross-owner reservation key", async () => {
    const id = await owner(),
      other = await owner(),
      key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserve(id, key)),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect((await snapshot(id)).included_remaining_cents).toBe(197);
    await expect(reserve(other, key)).rejects.toThrow("identity mismatch");
  });
  it("adds an upgrade once and preserves a downgrade until next reset", async () => {
    const id = await owner();
    await reserve(id, randomUUID(), 20);
    expect((await snapshot(id, 1000, true)).included_remaining_cents).toBe(940);
    expect((await snapshot(id, 200, true)).included_remaining_cents).toBe(940);
    expect((await snapshot(id, 1000, true)).included_remaining_cents).toBe(940);
    await db.query(
      "update manager_comms_billing_accounts set credit_period_start=credit_period_start-interval '1 month' where manager_user_id=$1",
      [id],
    );
    expect((await snapshot(id, 200, true)).included_remaining_cents).toBe(200);
  });
  it("fulfills a paid pack once, spends included first, and reverses refunds once", async () => {
    const id = await owner(),
      purchase = randomUUID(),
      session = randomUUID(),
      payment = randomUUID();
    await db.query(
      "insert into manager_comms_credit_purchases(id,manager_user_id,credit_cents) values($1,$2,500)",
      [purchase, id],
    );
    const fulfill = () =>
      db.query(
        "select fulfill_comms_credit_purchase($1,$2,$3,$4,500,$5,null)",
        [purchase, id, session, payment, randomUUID()],
      );
    await Promise.all(Array.from({ length: 8 }, fulfill));
    expect((await snapshot(id)).purchased_remaining_cents).toBe(500);
    await reserve(id, randomUUID(), 100);
    expect(await snapshot(id)).toMatchObject({
      included_remaining_cents: 0,
      purchased_remaining_cents: 400,
    });
    await Promise.all(
      Array.from({ length: 8 }, () =>
        db.query("select reverse_comms_credit_purchase($1,500,$2,'refund')", [
          payment,
          randomUUID(),
        ]),
      ),
    );
    expect(await snapshot(id)).toMatchObject({
      purchased_remaining_cents: 0,
      paused: true,
    });
  });
  it("absorbs unavoidable incoming overage without debt", async () => {
    const id = await owner();
    await reserve(id, randomUUID(), 100, true);
    expect(await snapshot(id)).toMatchObject({
      included_remaining_cents: 0,
      purchased_remaining_cents: 0,
      paused: false,
    });
    expect(
      (
        await db.query(
          "select sum(platform_absorbed_cents)::integer as n from manager_comms_usage_events where manager_user_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(100);
  });
  it("returns unused voice hold once, including a declined recording", async () => {
    const id = await owner(),
      key = randomUUID();
    await db.query(
      "select reserve_comms_credit($1,200,250,$2,'voice_minute',5,4)",
      [id, key],
    );
    await db.query("select settle_comms_credit_quantity($1,$2,1)", [id, key]);
    await db.query("select settle_comms_credit_quantity($1,$2,1)", [id, key]);
    expect((await snapshot(id)).included_remaining_cents).toBe(196);
    const recording = randomUUID();
    await db.query(
      "select reserve_comms_credit($1,200,250,$2,'voice_recording_minute',5,1)",
      [id, recording],
    );
    await db.query("select settle_comms_credit_quantity($1,$2,0)", [
      id,
      recording,
    ]);
    expect((await snapshot(id)).included_remaining_cents).toBe(196);
  });
  it("manager saves cannot restore revoked staff coverage under concurrency", async () => {
    const id = await owner();
    await db.query("select set_staff_payment_fee_override($1,'proplane')", [
      id,
    ]);
    await Promise.all([
      db.query("select set_staff_payment_fee_override($1,null)", [id]),
      ...Array.from({ length: 10 }, () =>
        db.query("select save_manager_payment_preferences($1,$2)", [
          id,
          { serviceFeePayer: "proplane", adminServiceFeeOverride: "proplane" },
        ]),
      ),
    ]);
    const stored = (
      await db.query(
        "select manual_payments from manager_automation_settings where manager_user_id=$1",
        [id],
      )
    ).rows[0].manual_payments;
    expect(stored.adminServiceFeeOverride).toBeUndefined();
  });
  it("client roles cannot execute spending or staff-grant functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      const privileges = await db.query(
        "select has_function_privilege($1,'public.reserve_comms_credit(uuid,integer,integer,text,text,numeric,integer,jsonb,boolean)','execute') as spend, has_function_privilege($1,'public.set_staff_payment_fee_override(uuid,text)','execute') as staff",
        [role],
      );
      expect(privileges.rows[0]).toEqual({ spend: false, staff: false });
    }
  });
  it("claims each monthly budget threshold once under concurrent settlement", async () => {
    const id = await owner();
    await snapshot(id,200,true);
    await db.query("update manager_comms_billing_accounts set monthly_budget_cents=100 where manager_user_id=$1",[id]);
    await reserve(id,randomUUID(),30);
    const claims=await Promise.all(Array.from({length:8},()=>db.query("select claim_comms_budget_alert($1) as alert",[id])));
    expect(claims.map(x=>x.rows[0].alert).filter(Boolean)).toEqual([{threshold:80,used:90,budget:100}]);
    await reserve(id,randomUUID(),10);
    expect((await db.query("select claim_comms_budget_alert($1) as alert",[id])).rows[0].alert).toEqual({threshold:100,used:120,budget:100});
    expect((await db.query("select claim_comms_budget_alert($1) as alert",[id])).rows[0].alert).toBeNull();
  });

});
