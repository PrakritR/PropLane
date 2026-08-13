import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import {
  applicationHasGroup,
  normalizeGroupId,
  type ApplicationGroupMember,
  type GroupRole,
} from "@/lib/rental-application/application-groups";
import { applicationStatusForRow } from "@/lib/rental-application/application-group-row-status";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

function rowToGroupMember(row: DemoApplicantRow): ApplicationGroupMember {
  const app = row.application;
  return {
    id: row.id,
    name: applicantDisplayName(row) || row.name || row.email || "Applicant",
    email: row.email?.trim() || app?.email?.trim() || "",
    role: app?.groupRole ?? null,
    status: applicationStatusForRow(row),
  };
}

/**
 * Load other applicants sharing this row's Group ID for embedding in the
 * application PDF. Scoped to the listing manager's records when known.
 */
export async function loadApplicationGroupMembersForDocument(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  row: DemoApplicantRow,
  opts: { managerUserId: string | null; excludeCurrent?: boolean },
): Promise<ApplicationGroupMember[]> {
  const groupId = normalizeGroupId(row.application?.groupId);
  if (!applicationHasGroup(row.application) || !groupId) return [];

  let query = db
    .from("manager_application_records")
    .select("id, row_data")
    .eq("row_data->application->>applyingAsGroup", "yes");

  const managerUserId = opts.managerUserId?.trim();
  if (managerUserId) query = query.eq("manager_user_id", managerUserId);

  const { data, error } = await query;
  if (error || !data?.length) return [];

  const members: ApplicationGroupMember[] = [];
  for (const record of data) {
    const sibling = record.row_data as DemoApplicantRow | null;
    if (!sibling?.application) continue;
    const recordId = String(record.id ?? sibling.id ?? "").trim();
    if (normalizeGroupId(sibling.application.groupId) !== groupId) continue;
    if (opts.excludeCurrent !== false && recordId && recordId === row.id) continue;
    members.push(rowToGroupMember({ ...sibling, id: recordId || sibling.id }));
  }

  members.sort((a, b) => {
    const roleOrder = (role: GroupRole | null) => (role === "first" ? 0 : role === "joining" ? 1 : 2);
    const ra = roleOrder(a.role);
    const rb = roleOrder(b.role);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return members;
}
