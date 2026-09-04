/** Code-split loaders for heavy portal panels (imported on demand per section). */

export async function loadManagerResidents() {
  return (await import("@/components/portal/pro-residents")).ManagerResidents;
}

export async function loadManagerScreenings() {
  return (await import("@/components/portal/pro-screenings")).ManagerScreenings;
}

export async function loadManagerBackgroundChecks() {
  return (await import("@/components/portal/pro-background-checks")).ManagerBackgroundChecks;
}

export async function loadManagerApplications() {
  return (await import("@/components/portal/pro-applications")).ManagerApplications;
}

export async function loadManagerProperties() {
  return (await import("@/components/portal/pro-properties")).ManagerProperties;
}

export async function loadManagerTours() {
  return (await import("@/components/portal/pro-tours")).ManagerTours;
}

export async function loadPortalCalendar() {
  return (await import("@/components/portal/portal-calendar")).PortalCalendar;
}

export async function loadManagerAllServicesPanel() {
  return (await import("@/components/portal/pro-all-services-panel")).ManagerAllServicesPanel;
}

export async function loadManagerTaskList() {
  return (await import("@/components/portal/pro-task-list")).ManagerTaskList;
}

export async function loadManagerInbox() {
  return (await import("@/components/portal/pro-inbox")).ManagerInbox;
}

export async function loadManagerCommunication() {
  return (await import("@/components/portal/pro-communication")).ManagerCommunication;
}

export async function loadManagerFinancesPanel() {
  return (await import("@/components/portal/pro-finances-panel")).ManagerFinancesPanel;
}

export async function loadManagerDocumentsPanel() {
  return (await import("@/components/portal/pro-documents-panel")).ManagerDocumentsPanel;
}

export async function loadManagerVendorsPanel() {
  return (await import("@/components/portal/pro-vendors-panel")).ManagerVendorsPanel;
}

export async function loadProAccountLinksPanel() {
  return (await import("@/components/portal/pro-account-links-panel")).ProAccountLinksPanel;
}

export async function loadResidentServicesPanel() {
  return (await import("@/components/portal/resident-services-panel")).ResidentServicesPanel;
}
