import type { AppRole } from "@agency-workload/contracts";

export const roles = ["owner", "admin", "planner", "member", "viewer"] as const;
export type AdminAction =
  | "audit:read"
  | "invitation:create"
  | "invitation:list"
  | "membership:deactivate"
  | "membership:list"
  | "membership:role"
  | "session:revoke";

export function can(role: AppRole, _action: AdminAction): boolean {
  return role === "owner" || role === "admin";
}

export function canAssignRole(actorRole: AppRole, targetRole: AppRole): boolean {
  if (actorRole === "owner") return true;
  return actorRole === "admin" && ["planner", "member", "viewer"].includes(targetRole);
}
