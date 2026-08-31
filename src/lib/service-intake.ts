import { isDemoModeActive } from "@/lib/demo/demo-session";
import { compactTaskPropertyLabel } from "@/lib/manager-task-display";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";
import {
  createManagerWorkOrderFromTaskForm,
  buildManagerTaskComposePrefill,
  managerTaskTypeFromFormKind,
  type ManagerTaskResidentOption,
} from "@/lib/manager-task-form-support";
import {
  readManagerWorkOrderRows,
  updateManagerWorkOrder,
} from "@/lib/manager-work-orders-storage";
import {
  readManagerVendorCategorySettings,
  vendorsMatchingTrade,
  type ManagerVendorRow,
} from "@/lib/manager-vendors-storage";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import {
  createScheduledWorkTask,
  scheduledTaskTitleForWorkOrder,
} from "@/lib/manager-scheduled-work-tasks";
import { suggestVendorsForWorkOrder } from "@/lib/work-order-auto-match";
import { sendWorkOrderToVendors } from "@/lib/work-order-vendor-offers";
import type { WorkAssignee } from "@/lib/work-assignment";
import {
  type ResidentMaintenanceCategoryLabel,
  workOrderCategoryForResidentLabel,
} from "@/lib/work-order-taxonomy";

/** Catalog add-on service types use listing offer ids; maintenance is a first-class intake path. */
export const MAINTENANCE_SERVICE_OFFER_ID = "axis:maintenance";

export function isMaintenanceServiceOffer(offerId: string): boolean {
  return offerId === MAINTENANCE_SERVICE_OFFER_ID;
}

export const MAINTENANCE_CATEGORY_OPTIONS: ResidentMaintenanceCategoryLabel[] = [
  "Plumbing",
  "Electrical",
  "HVAC",
  "Appliance",
  "Access / Locks",
  "General",
];

export function vendorTradeForMaintenanceCategory(
  category: ResidentMaintenanceCategoryLabel,
): string {
  switch (category) {
    case "Plumbing":
      return "Plumbing";
    case "Electrical":
      return "Electrical";
    case "HVAC":
      return "HVAC";
    case "Appliance":
      return "Appliance repair";
    case "Access / Locks":
    case "General":
    default:
      return "General maintenance";
  }
}

export function resolveDefaultVendorForMaintenance(
  managerUserId: string,
  category: ResidentMaintenanceCategoryLabel,
  vendors: ManagerVendorRow[],
): ManagerVendorRow | null {
  const trade = vendorTradeForMaintenanceCategory(category);
  const defaultId = readManagerVendorCategorySettings(managerUserId).defaultVendorIdByTrade[trade];
  if (defaultId) {
    const match = vendors.find((v) => v.id === defaultId && v.active !== false);
    if (match) return match;
  }
  return vendorsMatchingTrade(vendors.filter((v) => v.active !== false), trade)[0] ?? null;
}

function vendorAssignee(vendor: ManagerVendorRow): WorkAssignee {
  return { type: "vendor", id: vendor.id, name: vendor.name };
}

export type SubmitMaintenanceServiceIntakeInput = {
  managerUserId: string;
  propertyId: string;
  propertyLabel: string;
  resident: ManagerTaskResidentOption;
  title: string;
  notes: string;
  category: ResidentMaintenanceCategoryLabel;
  assignee: WorkAssignee | null;
  vendors: ManagerVendorRow[];
  roomLabel?: string;
};

export type SubmitMaintenanceServiceIntakeResult = {
  workOrderId: string;
  vendorName?: string;
  composePrefill: ManagerComposePrefill | null;
  vendorNotifyError?: string;
};

export async function submitMaintenanceServiceIntake(
  input: SubmitMaintenanceServiceIntakeInput,
): Promise<SubmitMaintenanceServiceIntakeResult> {
  const title = input.title.trim();
  const notes = input.notes.trim();
  const row = createManagerWorkOrderFromTaskForm({
    managerUserId: input.managerUserId,
    title,
    notes,
    categoryLabel: input.category,
    propertyId: input.propertyId,
    propertyLabel: input.propertyLabel,
    resident: input.resident,
    unitLabel: input.roomLabel,
  });

  let vendor: ManagerVendorRow | null = null;
  if (input.assignee?.type === "vendor") {
    vendor = input.vendors.find((v) => v.id === input.assignee!.id) ?? null;
  }
  if (!vendor) {
    vendor = resolveDefaultVendorForMaintenance(input.managerUserId, input.category, input.vendors);
  }
  if (!vendor) {
    const suggestions = suggestVendorsForWorkOrder(row, input.vendors, {
      allWorkOrders: readManagerWorkOrderRows(),
    });
    if (suggestions[0]) {
      vendor = input.vendors.find((v) => v.id === suggestions[0]!.vendorId) ?? null;
    }
  }

  const assignedAt = new Date().toISOString();
  let vendorName: string | undefined;
  let vendorNotifyError: string | undefined;

  if (vendor) {
    vendorName = vendor.name;
    updateManagerWorkOrder(row.id, (current) => ({
      ...current,
      vendorId: vendor!.id,
      vendorName: vendor!.name,
      vendorAssignedAt: assignedAt,
      selfAssigned: false,
      category: workOrderCategoryForResidentLabel(input.category),
    }));
    if (!isDemoModeActive()) {
      const notify = await sendWorkOrderToVendors(row.id, [vendor.id]);
      if (!notify.ok) vendorNotifyError = notify.error;
    }
  }

  const taskAssignee =
    input.assignee ??
    (vendor ? vendorAssignee(vendor) : null);

  await createScheduledWorkTask(input.managerUserId, {
    title: scheduledTaskTitleForWorkOrder(title),
    notes,
    propertyId: input.propertyId,
    propertyTitle: compactTaskPropertyLabel(input.propertyId, input.propertyLabel) ?? input.propertyLabel,
    roomLabel: input.roomLabel,
    assignee: taskAssignee ?? undefined,
    taskType: managerTaskTypeFromFormKind("work-order"),
    urgency: "urgent",
    priority: "medium",
    linkedWorkOrderId: row.id,
  });

  if (!isDemoModeActive()) {
    await deliverPortalInboxMessage({
      eventCategory: "maintenance",
      fromName: "Property Manager",
      toEmails: [input.resident.residentEmail],
      subject: `Maintenance request opened: ${title}`,
      text: [
        `Hi ${input.resident.residentName || "there"},`,
        "",
        "Your property manager logged a maintenance request on your behalf:",
        "",
        `Title: ${title}`,
        `Category: ${input.category}`,
        vendorName ? `Vendor: ${vendorName}` : null,
        notes ? `Details: ${notes}` : null,
        "",
        "Sign in to your PropLane resident portal to view updates under Services.",
      ]
        .filter(Boolean)
        .join("\n"),
      deliverViaEmail: true,
      deliverViaSms: true,
    });
  }

  const composePrefill = buildManagerTaskComposePrefill({
    kind: "work-order",
    title,
    notes,
    propertyLabel: input.propertyLabel,
    recipientEmail: input.resident.residentEmail,
    recipientName: input.resident.residentName,
  });

  return {
    workOrderId: row.id,
    vendorName,
    composePrefill,
    vendorNotifyError,
  };
}
