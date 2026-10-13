/**
 * A send about a workspace that has no work number of its own. One number per
 * workspace and no cross-workspace fallback, so the resolver refuses with this
 * code, the dispatcher blocks the message with it (never retried) and the
 * manager send route shows the message.
 */
export const WORKSPACE_NO_WORK_NUMBER_CODE = "workspace_has_no_work_number";
export const WORKSPACE_NO_WORK_NUMBER_MESSAGE = "This workspace has no work number.";
