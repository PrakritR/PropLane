import "server-only";
import { residentIdentityActor } from "@/lib/resident-identity/auth.server";
import { personaEnabled } from "@/lib/resident-identity/persona.server";
import { evaluateEvidencePolicy, type EvidencePolicy, type EvidenceProperty, type EvidencePurpose, type EvidenceResolution, type IdentityAttestation } from "@/lib/resident-evidence/policy";

/** The actor, property owner and location are read server-side, never supplied by the caller. */
export async function resolveResidentEvidencePolicy(propertyId: string, purpose: EvidencePurpose): Promise<EvidenceResolution> {
  if (process.env.RESIDENT_EVIDENCE_ENABLED !== "true") return { kind: "disabled" };
  if (!propertyId.trim() || !["application", "tour", "short_stay"].includes(purpose)) return { kind: "unavailable", reason: "invalid_request" };
  try {
    const actor = await residentIdentityActor();
    if (!actor) return { kind: "unavailable", reason: "authentication_required" };
    const [property, policy, identity] = await Promise.all([
      actor.db.from("manager_property_records").select("manager_user_id, property_data").eq("id", propertyId).maybeSingle(),
      actor.db.from("resident_evidence_policies").select("*").eq("property_id", propertyId).order("version", { ascending: false }).limit(1).maybeSingle(),
      actor.db.from("resident_identity_subjects").select("status, verified_at").eq("resident_user_id", actor.userId).maybeSingle(),
    ]);
    if (property.error || policy.error || identity.error) return { kind: "unavailable", reason: "policy_read_failed" };
    return evaluateEvidencePolicy({ enabled: true, propertyId, purpose, property: property.data as EvidenceProperty | null, policy: policy.data as EvidencePolicy | null, identity: identity.data as IdentityAttestation, personaConfigured: personaEnabled() });
  } catch {
    return { kind: "unavailable", reason: "policy_read_failed" };
  }
}
