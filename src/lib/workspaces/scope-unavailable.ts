/**
 * Thrown when the viewer's active workspace cannot be resolved (the workspace load failed).
 * A scope we cannot resolve must never read as "do not narrow": for an account that reaches
 * more than one workspace (a staff seat, a co-manager grant, two owned workspaces) that would
 * show workspace A's rows while workspace B is active. Callers let it propagate (the route
 * answers 503) or map it with `workspaceScopeUnavailableResponse`.
 */
export class WorkspaceScopeUnavailableError extends Error {
  readonly status = 503;
  constructor(message = "Could not resolve your workspace. Please retry.") {
    super(message);
    this.name = "WorkspaceScopeUnavailableError";
  }
}

export function isWorkspaceScopeUnavailable(error: unknown): error is WorkspaceScopeUnavailableError {
  return error instanceof WorkspaceScopeUnavailableError;
}
