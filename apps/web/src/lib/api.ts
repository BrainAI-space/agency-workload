import type { AppRole } from "@agency-workload/contracts";

export interface SessionUser {
  id: string;
  organizationId: string;
  role: AppRole;
}

export interface SessionResponse {
  authenticated: boolean;
  csrfToken?: string;
  user?: SessionUser;
}

export interface Member {
  userId: string;
  email: string;
  role: AppRole;
  active: boolean;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: AppRole;
  status: string;
  deliveryStatus: "pending" | "sent" | "failed";
  deliveryAttempts: number;
  expiresAt: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, string>;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: object;
  csrfToken?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("Only same-origin API paths are allowed");
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") headers["content-type"] = "application/json";
  if (options.csrfToken) headers["x-csrf-token"] = options.csrfToken;
  const response = await fetch(path, {
    method,
    credentials: "include",
    headers,
    ...(method !== "GET" ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json()) as unknown)
    : null;
  if (!response.ok) {
    const code =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "request_failed";
    throw new ApiError(response.status, code);
  }
  return payload as T;
}

export const api = {
  getSession: () => request<SessionResponse>("/api/v1/auth/session"),
  requestCode: (email: string) =>
    request<{ message: string }>("/api/v1/auth/request-code", {
      method: "POST",
      body: { email },
    }),
  verifyCode: (email: string, code: string) =>
    request<SessionResponse>("/api/v1/auth/verify-code", {
      method: "POST",
      body: { email, code },
    }),
  logout: (csrfToken: string) =>
    request<{ ok: true }>("/api/v1/auth/logout", { method: "POST", csrfToken }),
  listMembers: () => request<Member[]>("/api/v1/admin/memberships"),
  listInvitations: () => request<Invitation[]>("/api/v1/admin/invitations"),
  listAudit: () => request<AuditEvent[]>("/api/v1/admin/audit"),
  createInvitation: (email: string, role: AppRole, csrfToken: string) =>
    request<Pick<Invitation, "id" | "role" | "status" | "deliveryStatus">>(
      "/api/v1/admin/invitations",
      { method: "POST", body: { email, role }, csrfToken },
    ),
  resendInvitation: (id: string, csrfToken: string) =>
    request<{ deliveryStatus: Invitation["deliveryStatus"] }>(
      `/api/v1/admin/invitations/${encodeURIComponent(id)}/resend`,
      { method: "POST", csrfToken },
    ),
  changeMemberRole: (id: string, role: AppRole, csrfToken: string) =>
    request<{ ok: true }>(`/api/v1/admin/memberships/${encodeURIComponent(id)}/role`, {
      method: "PATCH",
      body: { role },
      csrfToken,
    }),
  deactivateMember: (id: string, csrfToken: string) =>
    request<{ ok: true }>(`/api/v1/admin/memberships/${encodeURIComponent(id)}/deactivate`, {
      method: "POST",
      csrfToken,
    }),
};
