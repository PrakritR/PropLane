/** Code-split loaders for heavy portal panels (imported on demand per section). */

export async function loadManagerResidents() {
  return (await import("@/components/portal/manager-residents")).ManagerResidents;
}

export async function loadManagerScreenings() {
  return (await import("@/components/portal/manager-screenings")).ManagerScreenings;
}

export async function loadManagerBackgroundChecks() {
  return (await import("@/components/portal/manager-background-checks")).ManagerBackgroundChecks;
}

export async function loadManagerApplications() {
  return (await import("@/components/portal/manager-applications")).ManagerApplications;
}

export async function loadManagerProperties() {
  return (await import("@/components/portal/manager-properties")).ManagerProperties;
}

export async function loadManagerTours() {
  return (await import("@/components/portal/manager-tours")).ManagerTours;
}

export async function loadPortalCalendar() {
  return (await import("@/components/portal/portal-calendar")).PortalCalendar;
}

export async function loadManagerAllServicesPanel() {
  return (await import("@/components/portal/manager-all-services-panel")).ManagerAllServicesPanel;
}

export async function loadManagerTaskList() {
  return (await import("@/components/portal/manager-task-list")).ManagerTaskList;
}

export async function loadManagerInbox() {
  return (await import("@/components/portal/manager-inbox")).ManagerInbox;
}

export async function loadManagerCommunication() {
  return (await import("@/components/portal/manager-communication")).ManagerCommunication;
}

export async function loadManagerFinancesPanel() {
  return (await import("@/components/portal/manager-finances-panel")).ManagerFinancesPanel;
}

export async function loadManagerDocumentsPanel() {
  return (await import("@/components/portal/manager-documents-panel")).ManagerDocumentsPanel;
}

export async function loadManagerVendorsPanel() {
  return (await import("@/components/portal/manager-vendors-panel")).ManagerVendorsPanel;
}

export async function loadProAccountLinksPanel() {
  return (await import("@/components/portal/pro-account-links-panel")).ProAccountLinksPanel;
}

export async function loadResidentServicesPanel() {
  return (await import("@/components/portal/resident-services-panel")).ResidentServicesPanel;
}
