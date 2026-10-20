/**
 * The dev values every run must leave behind. A scenario that mutates shared config (sms_runtime_config.line_mode,
 * platform_service_settings.owner_user_id) restores it in `finally` and then calls verifyBaseline, which re-reads both.
 */
export const DEV_BASELINE = Object.freeze({
  line_mode: "shadow",
  service_owner_user_id: "3077e0e3-fbb0-4ffb-87b7-8d354b8d19e5",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function readConfigState(db) {
  const cfg = await db.from("sms_runtime_config").select("line_mode, shared_pilot_workspace_ids, pilot_manager_user_ids").eq("singleton", true).maybeSingle();
  const svc = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
  if (cfg.error || svc.error) throw new Error(`cannot read config: ${cfg.error?.message ?? svc.error?.message}`);
  return { line_mode: cfg.data?.line_mode ?? null, pilot: cfg.data?.shared_pilot_workspace_ids ?? [], pilotManagers: cfg.data?.pilot_manager_user_ids ?? [], service_owner_user_id: svc.data?.owner_user_id ?? null };
}

/** Put both values back to the baseline (a killed run may have left per_workspace / a fixture owner). Returns the verified state. */
export async function restoreBaseline(db, log = console.log) {
  let state = await readConfigState(db);
  const differs = () => (state.pilot ?? []).length > 0 || state.line_mode !== DEV_BASELINE.line_mode || state.service_owner_user_id !== DEV_BASELINE.service_owner_user_id;
  for (let attempt = 0; attempt < 4 && differs(); attempt += 1) {
    log(`  config differs from baseline (${JSON.stringify({ line_mode: state.line_mode, service_owner_user_id: state.service_owner_user_id })}); restoring`);
    if ((state.pilot ?? []).length > 0) await db.from("sms_runtime_config").update({ shared_pilot_workspace_ids: [] }).eq("singleton", true);
    if (state.line_mode !== DEV_BASELINE.line_mode) await db.from("sms_runtime_config").update({ line_mode: DEV_BASELINE.line_mode }).eq("singleton", true);
    // upsert: a run that read the row as "absent" through a database timeout used to delete it; put it back whole.
    if (state.service_owner_user_id !== DEV_BASELINE.service_owner_user_id) await db.from("platform_service_settings").upsert({ singleton: true, owner_user_id: DEV_BASELINE.service_owner_user_id }, { onConflict: "singleton" });
    await sleep(1000 * (attempt + 1));
    state = await readConfigState(db);
  }
  if (differs()) throw new Error(`baseline NOT restored: ${JSON.stringify(state)}`);
  return state;
}
