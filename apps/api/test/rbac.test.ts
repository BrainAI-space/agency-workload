import { describe, expect, it } from "vitest";
import { type AdminAction, can, canAssignRole, roles } from "../src/rbac.js";

describe("five-role RBAC", () => {
  const actions: AdminAction[] = [
    "audit:read",
    "invitation:create",
    "invitation:list",
    "membership:deactivate",
    "membership:list",
    "membership:role",
    "session:revoke",
  ];

  it("defines exactly the approved roles", () => {
    expect(roles).toEqual(["owner", "admin", "planner", "member", "viewer"]);
  });

  it("allows owner/admin administration and denies every admin action to ordinary roles", () => {
    for (const action of actions) {
      expect(can("owner", action)).toBe(true);
      expect(can("admin", action)).toBe(true);
      for (const role of ["planner", "member", "viewer"] as const) {
        expect(can(role, action)).toBe(false);
      }
    }
  });

  it("restricts owner/admin assignment and prevents admin self-elevation", () => {
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("owner", "admin")).toBe(true);
    expect(canAssignRole("admin", "admin")).toBe(false);
    expect(canAssignRole("admin", "owner")).toBe(false);
    expect(canAssignRole("admin", "planner")).toBe(true);
  });
});
