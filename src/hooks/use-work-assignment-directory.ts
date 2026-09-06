"use client";

import { useEffect, useMemo, useState } from "react";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  MANAGER_VENDORS_EVENT,
  readOwnManagerVendorRows,
  syncManagerVendorsFromServer,
} from "@/lib/manager-vendors-storage";
import { readProRelationships, syncProRelationshipsFromServer } from "@/lib/pro-relationships";
import { PRO_RELATIONSHIPS_EVENT } from "@/lib/property-pipeline-events";
import { trimmedText } from "@/lib/trimmed-text";

export type WorkAssignmentTeamMember = {
  userId: string;
  name?: string | null;
  email?: string | null;
};

/**
 * Team members (self + linked co-managers) and vendors for assignment pickers.
 */
export function useWorkAssignmentDirectory(opts?: {
  managerUserId?: string | null;
  managerName?: string | null;
  /**
   * Pass false when the viewer is NOT a manager.
   *
   * This directory is the manager's own team and vendor list, and
   * `/api/portal-vendors` answers 403 to anyone else by design. The shared
   * calendar renders in the vendor portal too, so calling it unconditionally
   * put a 403 in the console on every vendor calendar load — an authorization
   * boundary working correctly, reported as a bug because the client asked a
   * question it had no business asking (PRP-215). Defaults to true.
   */
  enabled?: boolean;
}) {
  const session = useManagerUserId();
  const enabled = opts?.enabled !== false;
  const userId = opts?.managerUserId ?? session.userId;
  const email = session.email;
  const [relationshipTick, setRelationshipTick] = useState(0);
  const [vendorTick, setVendorTick] = useState(0);

  useEffect(() => {
    if (!userId || !enabled) return;
    void syncProRelationshipsFromServer(userId).catch(() => undefined);
    void syncManagerVendorsFromServer().catch(() => undefined);
  }, [userId, enabled]);

  useEffect(() => {
    const onRelationships = () => setRelationshipTick((n) => n + 1);
    const onVendors = () => setVendorTick((n) => n + 1);
    window.addEventListener(PRO_RELATIONSHIPS_EVENT, onRelationships);
    window.addEventListener(MANAGER_VENDORS_EVENT, onVendors);
    return () => {
      window.removeEventListener(PRO_RELATIONSHIPS_EVENT, onRelationships);
      window.removeEventListener(MANAGER_VENDORS_EVENT, onVendors);
    };
  }, []);

  const teamMembers = useMemo((): WorkAssignmentTeamMember[] => {
    if (!userId || !enabled) return [];
    void relationshipTick;
    const members: WorkAssignmentTeamMember[] = [];
    const selfLabel = trimmedText(opts?.managerName) || trimmedText(email) || "You";
    members.push({ userId, name: selfLabel, email });
    const seen = new Set<string>([userId]);
    for (const rel of readProRelationships(userId)) {
      const linkedId = trimmedText(rel.linkedUserId);
      if (!linkedId || seen.has(linkedId)) continue;
      seen.add(linkedId);
      members.push({
        userId: linkedId,
        name: trimmedText(rel.linkedDisplayName) || trimmedText(rel.linkedAxisId) || "Team member",
      });
    }
    return members;
  }, [userId, email, opts?.managerName, relationshipTick, enabled]);

  const vendors = useMemo(() => {
    void vendorTick;
    if (!userId || !enabled) return [];
    return readOwnManagerVendorRows(userId);
  }, [userId, vendorTick, enabled]);

  return { teamMembers, vendors, ready: session.ready };
}
