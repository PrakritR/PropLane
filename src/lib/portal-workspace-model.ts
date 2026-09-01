import type { PortalKind } from "@/lib/portal-types";
import {
  demoKpis,
  demoManagerSubscriberRows,
  demoResidentLeaseRows,
  demoResidentPropertyRows,
} from "@/data/demo-portal";
import { adminPropertyRows, applicantRows, inboxPreviewRows, paymentRows, workOrderRows } from "@/data/mock-tables";
export type WorkspaceAction = {
  label: string;
  kind: "toast" | "modal";
  message: string;
};

export type WorkspaceModel = {
  eyebrow: string;
  title: string;
  subtitle: string;
  kpis?: { label: string; value: string; hint: string }[];
  columns?: { key: string; label: string }[];
  rows?: Record<string, string>[];
  actions: WorkspaceAction[];
  notes?: string;
  emptyState?: { title: string; description?: string; actionLabel?: string };
  showToolbar?: boolean;
  showQuickLinks?: boolean;
};

function actionsFor(portal: PortalKind, section: string): WorkspaceAction[] {
  if (portal === "manager" || portal === "pro") {
    if (section === "relationships" || section === "teams") {
      return [];
    }
    if (section === "properties") {
      return [
        { label: "Create listing", kind: "toast", message: "Opening listing editor…" },
        {
          label: "Export CSV",
          kind: "modal",
          message: "Exports will connect to your database later.",
        },
      ];
    }
    if (section === "applicants" || section === "applications") {
      return [
        {
          label: "Approve applicant",
          kind: "toast",
          message: "Applicant approved.",
        },
        {
          label: "Request docs",
          kind: "modal",
          message: "Messaging will route through Inbox once connected.",
        },
      ];
    }
    if (section === "payments")
      return [
        {
          label: "View payment",
          kind: "modal",
          message: "Live payment processing is disabled in this shell.",
        },
        { label: "Send reminder", kind: "toast", message: "Reminder queued…" },
      ];
    if (section === "stripe")
      return [
        {
          label: "Payout dashboard",
          kind: "modal",
          message: "Open Payments, then Payouts, to finish setup in Stripe.",
        },
      ];
    if (section === "work-orders") {
      return [
        {
          label: "Add work order",
          kind: "modal",
          message: "Open Services → Work orders, then click Add work order to create a request on behalf of a resident or log completed work.",
        },
        {
          label: "Assign vendor",
          kind: "modal",
          message: "Open Services → Work orders, expand a row, and pick a vendor from your directory.",
        },
      ];
    }
    if (section === "documents")
      return [
        {
          label: "Upload lease",
          kind: "modal",
          message: "Uploads are disabled in the scaffold.",
        },
      ];
  }

  if (portal === "resident") {
    if (section === "properties" || section === "applications" || section === "lease" || section === "calendar")
      return [];
    if (section === "payments")
      return [
        { label: "Add payment", kind: "toast", message: "No charges are processed yet." },
        {
          label: "Download receipt",
          kind: "modal",
          message: "Receipts will generate from real ledgers later.",
        },
      ];
    if (section === "work-orders")
      return [
        {
          label: "Submit work order",
          kind: "toast",
          message: "Request captured.",
        },
      ];
    if (section === "inbox")
      return [
        {
          label: "New message",
          kind: "modal",
          message: "Messaging is not wired yet.",
        },
      ];
    if (section === "profile")
      return [
        {
          label: "Edit info",
          kind: "toast",
          message: "Profile editing is not connected yet.",
        },
      ];
  }

  if (portal === "admin") {
    if (section === "properties") return [];
    if (
      section === "axis-users" ||
      section === "events" ||
      section === "applications" ||
      section === "payments" ||
      section === "work-orders"
    )
      return [];
    if (section === "inbox")
      return [
        {
          label: "New message",
          kind: "modal",
          message: "Messaging is not wired yet.",
        },
      ];
    if (section === "profile")
      return [
        {
          label: "Edit info",
          kind: "toast",
          message: "Profile editing is not connected yet.",
        },
      ];
    if (section === "tools")
      return [
        {
          label: "Run Airtable sync",
          kind: "modal",
          message: "Airtable sync is a placeholder in this build.",
        },
        {
          label: "Open billing dashboard",
          kind: "modal",
          message: "External billing tools are not connected in this build.",
        },
      ];
    if (section === "users")
      return [
        {
          label: "Manage roles",
          kind: "modal",
          message: "RBAC editor ships in a later milestone.",
        },
      ];
  }

  return [
    {
      label: "Primary action",
      kind: "toast",
      message: "Action recorded.",
    },
  ];
}

export function buildPortalWorkspaceModel(
  portal: PortalKind,
  section: string,
  tabId: string,
): WorkspaceModel {
  const eyebrow = `${portal === "pro" ? "PropLane Pro" : portal === "manager" ? "Manager" : portal === "resident" ? "Resident" : "Admin"} workspace`;

  if (section === "dashboard") {
    return {
      eyebrow,
      title: "Dashboard",
      subtitle:
        portal === "admin" || portal === "resident"
          ? ""
          : "Snapshot of operations. Numbers are illustrative until integrations are enabled.",
      kpis:
        portal === "resident"
          ? [
              {
                label: "Rent due",
                value: "$950.00",
                hint: "Due May 1 · autopay off",
              },
              {
                label: "Open requests",
                value: "1",
                hint: "Maintenance: sink leak",
              },
              {
                label: "Unread messages",
                value: "3",
                hint: "Inbox previews below",
              },
            ]
          : portal === "admin"
            ? [
                {
                  label: "Occupancy",
                  value: "92.4%",
                  hint: "Portfolio-wide",
                },
                {
                  label: "Open work orders",
                  value: "37",
                  hint: "Across all managers",
                },
                {
                  label: "Pending approvals",
                  value: "6",
                  hint: "Properties + leases",
                },
              ]
            : [
                {
                  label: "Active listings",
                  value: "14",
                  hint: "Across your portfolio",
                },
                {
                  label: "Applicants (new)",
                  value: "5",
                  hint: "Needs first review",
                },
                {
                  label: "Late payments",
                  value: "2",
                  hint: "Automations off",
                },
              ],
      columns: [
        { key: "title", label: "Signal" },
        { key: "detail", label: "Detail" },
        { key: "owner", label: "Owner" },
      ],
      rows: [
        {
          title: "Leasing velocity",
          detail: "3 applications submitted in the last 24h",
          owner: "Leasing",
        },
        {
          title: "Maintenance SLA",
          detail: "Average first response: 6h 12m",
          owner: "Operations",
        },
        {
          title: "Resident sentiment",
          detail: "4.7 / 5 from last 30 tour surveys",
          owner: "Experience",
        },
      ],
      actions: actionsFor(portal, section),
    };
  }

  if (section === "inbox") {
    if (portal === "admin") {
      return {
        eyebrow,
        title: "Inbox",
        subtitle: "",
        showToolbar: false,
        showQuickLinks: false,
        actions: actionsFor(portal, section),
        columns: [
          { key: "from", label: "From" },
          { key: "subject", label: "Subject" },
          { key: "preview", label: "Preview" },
          { key: "when", label: "When" },
          { key: "unread", label: "Unread" },
        ],
        rows: inboxPreviewRows as unknown as Record<string, string>[],
      };
    }

    if (portal === "resident") {
      return {
        eyebrow,
        title: "Inbox",
        subtitle: "",
        showToolbar: false,
        showQuickLinks: false,
        actions: actionsFor(portal, section),
        columns: [
          { key: "from", label: "From" },
          { key: "subject", label: "Subject" },
          { key: "preview", label: "Preview" },
          { key: "when", label: "When" },
          { key: "unread", label: "Unread" },
        ],
        rows: inboxPreviewRows as unknown as Record<string, string>[],
      };
    }

    return {
      eyebrow,
      title: "Inbox",
      subtitle:
        "Compose opens when messaging is connected.",
      columns: [
        { key: "from", label: "From" },
        { key: "subject", label: "Subject" },
        { key: "preview", label: "Preview" },
        { key: "when", label: "When" },
        { key: "unread", label: "Unread" },
      ],
      rows: inboxPreviewRows.map((r) => ({
        from: r.from,
        subject: r.subject,
        preview: r.preview,
        when: r.when,
        unread: r.unread,
      })),
      actions: actionsFor(portal, section),
    };
  }

  if (section === "payments") {
    if (portal === "resident") {
      return {
        eyebrow,
        title: "Payments",
        subtitle: "",
        kpis: [
          { label: "Pending", value: demoKpis.payments.pending, hint: "" },
          { label: "Overdue", value: demoKpis.payments.overdue, hint: "" },
          { label: "Paid", value: demoKpis.payments.paid, hint: "" },
        ],
        showToolbar: false,
        showQuickLinks: false,
        actions: actionsFor(portal, section),
        columns: [
          { key: "resident", label: "Resident" },
          { key: "unit", label: "Unit" },
          { key: "amount", label: "Amount" },
          { key: "due", label: "Due" },
          { key: "status", label: "Status" },
        ],
        rows: paymentRows as unknown as Record<string, string>[],
      };
    }

    return {
      eyebrow,
      title: "Payments",
      subtitle: "Ledger rows are illustrative. No charges are processed.",
      columns: [
        { key: "resident", label: "Resident" },
        { key: "unit", label: "Unit" },
        { key: "amount", label: "Amount" },
        { key: "due", label: "Due" },
        { key: "status", label: "Status" },
      ],
      rows: paymentRows as unknown as Record<string, string>[],
      actions: actionsFor(portal, section),
    };
  }

  if (section === "applicants") {
    return {
      eyebrow,
      title: "Applicants",
      subtitle: "Pipeline view.",
      columns: [
        { key: "name", label: "Applicant" },
        { key: "property", label: "Property" },
        { key: "stage", label: "Stage" },
      ],
      rows: applicantRows as unknown as Record<string, string>[],
      actions: actionsFor(portal, section),
    };
  }

  if (section === "work-orders") {
    if (portal === "resident") {
      return {
        eyebrow,
        title: "Work orders",
        subtitle: "",
        kpis: [
          { label: "Open", value: demoKpis.workOrders.open, hint: "" },
          { label: "Scheduled", value: demoKpis.workOrders.scheduled, hint: "" },
          { label: "Completed", value: demoKpis.workOrders.completed, hint: "" },
        ],
        showToolbar: false,
        showQuickLinks: false,
        actions: actionsFor(portal, section),
        columns: [
          { key: "id", label: "ID" },
          { key: "unit", label: "Unit" },
          { key: "title", label: "Title" },
          { key: "priority", label: "Priority" },
          { key: "status", label: "Status" },
        ],
        rows: workOrderRows as unknown as Record<string, string>[],
      };
    }

    return {
      eyebrow,
      title: "Work orders",
      subtitle: "Statuses update locally until integrations are enabled.",
      columns: [
        { key: "id", label: "ID" },
        { key: "unit", label: "Unit" },
        { key: "title", label: "Title" },
        { key: "priority", label: "Priority" },
        { key: "status", label: "Status" },
      ],
      rows: workOrderRows as unknown as Record<string, string>[],
      actions: actionsFor(portal, section),
    };
  }

  if (portal === "resident" && section === "properties") {
    return {
      eyebrow,
      title: "Properties",
      subtitle: "",
      showToolbar: false,
      showQuickLinks: false,
      actions: actionsFor(portal, section),
      columns: [
        { key: "building", label: "Building" },
        { key: "unit", label: "Unit" },
        { key: "manager", label: "Manager" },
        { key: "since", label: "Since" },
      ],
      rows: demoResidentPropertyRows as unknown as Record<string, string>[],
    };
  }

  if (portal === "resident" && section === "applications") {
    return {
      eyebrow,
      title: "Applications",
      subtitle: "",
      kpis: [
        { label: "Pending", value: demoKpis.applications.pending, hint: "" },
        { label: "Approved", value: demoKpis.applications.approved, hint: "" },
        { label: "Rejected", value: demoKpis.applications.rejected, hint: "" },
      ],
      showToolbar: false,
      showQuickLinks: false,
      actions: actionsFor(portal, section),
      columns: [
        { key: "name", label: "Applicant" },
        { key: "property", label: "Property" },
        { key: "stage", label: "Stage" },
      ],
      rows: applicantRows as unknown as Record<string, string>[],
    };
  }

  if (portal === "resident" && section === "documents") {
    return {
      eyebrow,
      title: "Documents",
      subtitle: "",
      showToolbar: false,
      showQuickLinks: false,
      actions: actionsFor(portal, section),
      columns: [
        { key: "document", label: "Document" },
        { key: "status", label: "Status" },
        { key: "updated", label: "Updated" },
      ],
      rows: demoResidentLeaseRows as unknown as Record<string, string>[],
    };
  }

  if (portal === "resident" && section === "lease") {
    return {
      eyebrow,
      title: "Lease",
      subtitle: "",
      kpis: [
        { label: "Manager review", value: demoKpis.leases.managerReview, hint: "" },
        { label: "With resident", value: demoKpis.leases.withResident, hint: "" },
        { label: "Signed", value: demoKpis.leases.signed, hint: "" },
      ],
      showToolbar: false,
      showQuickLinks: false,
      actions: actionsFor(portal, section),
      columns: [
        { key: "document", label: "Document" },
        { key: "status", label: "Status" },
        { key: "updated", label: "Updated" },
      ],
      rows: demoResidentLeaseRows as unknown as Record<string, string>[],
    };
  }

  if (portal === "admin" && section === "properties") {
    return {
      eyebrow,
      title: "Properties",
      subtitle: "",
      showToolbar: false,
      showQuickLinks: false,
      actions: actionsFor(portal, section),
      columns: [
        { key: "name", label: "Property" },
        { key: "manager", label: "Manager" },
        { key: "units", label: "Units" },
        { key: "status", label: "Status" },
      ],
      rows: adminPropertyRows as unknown as Record<string, string>[],
    };
  }

  if (portal === "admin" && section === "axis-users") {
    return {
      eyebrow,
      title: "PropLane users",
      subtitle: "",
      kpis: [
        { label: "Current subscribers", value: demoKpis.managers.current, hint: "" },
        { label: "Past subscribers", value: demoKpis.managers.past, hint: "" },
      ],
      showToolbar: false,
      showQuickLinks: false,
      actions: actionsFor(portal, section),
      columns: [
        { key: "name", label: "Manager" },
        { key: "org", label: "Organization" },
        { key: "portfolio", label: "Portfolio" },
        { key: "status", label: "Status" },
        { key: "since", label: "Since" },
      ],
      rows: demoManagerSubscriberRows as unknown as Record<string, string>[],
    };
  }

  if (portal === "admin" && section === "applications") {
    return {
      eyebrow,
      title: "Applications",
      subtitle: "",
      kpis: [
        { label: "Pending", value: demoKpis.applications.pending, hint: "" },
        { label: "Approved", value: demoKpis.applications.approved, hint: "" },
        { label: "Rejected", value: demoKpis.applications.rejected, hint: "" },
      ],
      showToolbar: false,
      showQuickLinks: false,
      actions: actionsFor(portal, section),
      columns: [
        { key: "name", label: "Applicant" },
        { key: "property", label: "Property" },
        { key: "stage", label: "Stage" },
      ],
      rows: applicantRows as unknown as Record<string, string>[],
    };
  }

  if (portal === "admin" && section === "payments") {
    return {
      eyebrow,
      title: "Payments",
      subtitle: "",
      kpis: [
        { label: "Pending", value: demoKpis.payments.pending, hint: "" },
        { label: "Overdue", value: demoKpis.payments.overdue, hint: "" },
        { label: "Paid", value: demoKpis.payments.paid, hint: "" },
      ],
      showToolbar: false,
      showQuickLinks: false,
      actions: [
        { label: "Add payment", kind: "toast", message: "No charges are processed yet." },
        ...actionsFor(portal, section),
      ],
      columns: [
        { key: "resident", label: "Resident" },
        { key: "unit", label: "Unit" },
        { key: "amount", label: "Amount" },
        { key: "due", label: "Due" },
        { key: "status", label: "Status" },
      ],
      rows: paymentRows as unknown as Record<string, string>[],
    };
  }

  if (portal === "admin" && section === "work-orders") {
    return {
      eyebrow,
      title: "Work orders",
      subtitle: "",
      kpis: [
        { label: "Open", value: demoKpis.workOrders.open, hint: "" },
        { label: "Scheduled", value: demoKpis.workOrders.scheduled, hint: "" },
        { label: "Completed", value: demoKpis.workOrders.completed, hint: "" },
      ],
      showToolbar: false,
      showQuickLinks: false,
      actions: actionsFor(portal, section),
      columns: [
        { key: "id", label: "ID" },
        { key: "unit", label: "Unit" },
        { key: "title", label: "Title" },
        { key: "priority", label: "Priority" },
        { key: "status", label: "Status" },
      ],
      rows: workOrderRows as unknown as Record<string, string>[],
    };
  }

  if (portal === "resident" && section === "calendar") {
    return {
      eyebrow,
      title: "Calendar",
      subtitle: "",
      showToolbar: false,
      showQuickLinks: false,
      columns: [
        { key: "item", label: "Item" },
        { key: "window", label: "Window" },
        { key: "owner", label: "Owner" },
      ],
      rows: [
        {
          item: "Move-in orientation",
          window: "Sat · 11:00 AM",
          owner: "Community",
        },
        {
          item: "Rent due reminder",
          window: "May 1",
          owner: "Payments",
        },
      ],
      actions: actionsFor(portal, section),
    };
  }

  if (section === "leasing") {
    return {
      eyebrow,
      title: "Leasing",
      subtitle: `Pipeline view. Tab: ${humanize(tabId)}.`,
      notes:
        "Leasing boards are intentionally lightweight here; wire real statuses when your backend is ready.",
      columns: [
        { key: "item", label: "Item" },
        { key: "window", label: "Window" },
        { key: "owner", label: "Owner" },
      ],
      rows: [
        {
          item: "Tour block",
          window: "Sat · 10:00–2:00",
          owner: "Leasing",
        },
        {
          item: "Lease countersign",
          window: "Due Fri",
          owner: "Admin",
        },
        {
          item: "Vendor follow-up",
          window: "Due Wed",
          owner: "Maintenance",
        },
      ],
      actions: actionsFor(portal, section),
    };
  }

  if ((section === "calendar" || section === "analytics") && portal !== "resident" && portal !== "admin") {
    return {
      eyebrow,
      title: humanize(section),
      subtitle: `Calendar/analytics widgets render here. Tab: ${humanize(tabId)}.`,
      notes:
        "This section is intentionally visual-only: heatmaps, charts, and drag-and-drop scheduling will plug in later.",
      columns: [
        { key: "item", label: "Item" },
        { key: "window", label: "Window" },
        { key: "owner", label: "Owner" },
      ],
      rows: [
        {
          item: "Tour block",
          window: "Sat · 10:00–2:00",
          owner: "Leasing",
        },
        {
          item: "Lease countersign",
          window: "Due Fri",
          owner: "Admin",
        },
        {
          item: "Vendor follow-up",
          window: "Due Wed",
          owner: "Maintenance",
        },
      ],
      actions: actionsFor(portal, section),
    };
  }

  if (portal === "resident" && section === "profile") {
    return {
      eyebrow,
      title: "Profile",
      subtitle: "",
      showToolbar: false,
      showQuickLinks: false,
      columns: [
        { key: "field", label: "Field" },
        { key: "value", label: "Value" },
      ],
      rows: [
        { field: "Full name", value: "—" },
        { field: "Email", value: "—" },
        { field: "Phone", value: "—" },
        { field: "Resident ID", value: "—" },
      ],
      actions: actionsFor(portal, section),
    };
  }

  if (
    section === "documents" ||
    section === "settings" ||
    (section === "profile" && portal !== "admin" && portal !== "resident")
  ) {
    return {
      eyebrow,
      title: humanize(section),
      subtitle: `Form layout + file shelves. Tab: ${humanize(tabId)}.`,
      columns: [
        { key: "name", label: "Name" },
        { key: "type", label: "Type" },
        { key: "updated", label: "Updated" },
      ],
      rows: [
        { name: "Lease - Pioneer 12A.pdf", type: "Lease", updated: "Apr 2" },
        { name: "Move-in checklist.pdf", type: "Move-in", updated: "Mar 30" },
        { name: "HOA rules.pdf", type: "Property", updated: "Mar 12" },
      ],
      actions: actionsFor(portal, section),
    };
  }

  return {
    eyebrow,
    title: `${humanize(section)} · ${humanize(tabId)}`,
    subtitle:
      "Placeholder content. Replace with queries when backend wiring lands.",
    columns: [
      { key: "record", label: "Record" },
      { key: "state", label: "State" },
      { key: "owner", label: "Owner" },
    ],
    rows: [
      { record: "Sample A", state: "Ready", owner: "PropLane" },
      { record: "Sample B", state: "Queued", owner: "Manager" },
      { record: "Sample C", state: "Blocked", owner: "Admin" },
    ],
    actions: actionsFor(portal, section),
  };
}

function humanize(slug: string) {
  return slug
    .split(/[-_/]/g)
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join(" ");
}
