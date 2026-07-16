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

export type Scenario = "confirmed" | "confirmed_and_tentative";

export interface NamedItem {
  id: string;
  name: string;
  rowVersion: number;
}

export interface PlanningSettings {
  timezone: string;
  weekStartsOn: number;
  dateFormat: "DD MMM YYYY" | "MMM D, YYYY" | "YYYY-MM-DD";
  forecastHorizonWeeks: number;
  billableTargetPercent: number;
  rowVersion: number;
}

export interface WeekdaySchedule {
  isoWeekday: number;
  minutes: number;
}

export interface WorkSchedule {
  id: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  weekdays: WeekdaySchedule[];
}

export interface Person {
  id: string;
  name: string;
  email?: string;
  teamId: string | null;
  deliveryRoleId: string | null;
  tagIds?: string[];
  activeFrom: string;
  activeUntil: string | null;
  rowVersion: number;
  schedules?: WorkSchedule[];
}

export interface Project {
  id: string;
  clientId: string | null;
  name: string;
  kind: "billable" | "internal";
  status: "draft" | "tentative" | "confirmed" | "completed" | "cancelled";
  targetStart: string | null;
  targetEnd: string | null;
  rowVersion: number;
  completedAt: string | null;
}

export interface Allocation {
  id: string;
  personId: string;
  projectId: string;
  startDate: string;
  endDate: string;
  mode: "minutes_per_day" | "capacity_percent";
  minutesPerDay: number | null;
  capacityPercent: number | null;
  state: "confirmed" | "tentative";
  rowVersion: number;
  kind?: "billable" | "internal";
}

export interface DailyCapacity {
  personId: string;
  date: string;
  scheduledMinutes: number;
  leaveMinutes: number;
  capacityMinutes: number;
  confirmedMinutes: number;
  tentativeMinutes: number;
  billableConfirmedMinutes: number;
  internalConfirmedMinutes: number;
  tentativeBillableMinutes: number;
  tentativeInternalMinutes: number;
  availableConfirmedMinutes: number;
  availableScenarioMinutes: number;
  confirmedOverbookMinutes: number;
  potentialOverbookMinutes: number;
  billableUtilizationPercent: number | null;
  internalUtilizationPercent: number | null;
}

export interface CapacityConflict {
  personId: string;
  date: string;
  severity: "confirmed" | "potential";
  overbookMinutes: number;
  fingerprint: string;
}

export interface ScheduleResponse {
  start: string;
  end: string;
  scenario: Scenario;
  people: Array<{ personId: string; days: DailyCapacity[] }>;
  conflicts: CapacityConflict[];
}

export interface ForecastWeek {
  weekStart: string;
  capacityMinutes: number;
  confirmedBillableMinutes: number;
  confirmedInternalMinutes: number;
  tentativeBillableMinutes: number;
  tentativeInternalMinutes: number;
  confirmedUtilizationPercent: number | null;
  potentialUtilizationPercent: number | null;
  confirmedOverbookMinutes: number;
  potentialOverbookMinutes: number;
  billableTargetGapMinutes: number;
}

export interface ForecastResponse {
  generatedAt: string;
  timezone: string;
  weekStartsOn: number;
  assumptions: string;
  weeks: ForecastWeek[];
}

export interface EarliestStartResult {
  personId: string;
  start: string;
  end: string;
  minimumHeadroomMinutes: number;
  continuousAllocationSafe: boolean;
  explanation: string;
}

export interface DerivedConflict extends CapacityConflict {
  source: string;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
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
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  body?: object;
  csrfToken?: string;
  signal?: AbortSignal | undefined;
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
    ...(options.signal ? { signal: options.signal } : {}),
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

function query(path: string, values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
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
  getPlanningSettings: (signal?: AbortSignal) =>
    request<PlanningSettings>("/api/v1/planning/settings", { signal }),
  updatePlanningSettings: (body: PlanningSettings, csrfToken: string) =>
    request<PlanningSettings>("/api/v1/planning/settings", {
      method: "PATCH",
      body,
      csrfToken,
    }),
  listTeams: (signal?: AbortSignal) => request<NamedItem[]>("/api/v1/teams", { signal }),
  listDeliveryRoles: (signal?: AbortSignal) =>
    request<NamedItem[]>("/api/v1/delivery-roles", { signal }),
  listTags: (signal?: AbortSignal) => request<NamedItem[]>("/api/v1/tags", { signal }),
  listClients: (signal?: AbortSignal) => request<NamedItem[]>("/api/v1/clients", { signal }),
  createClient: (name: string, csrfToken: string) =>
    request<NamedItem>("/api/v1/clients", { method: "POST", body: { name }, csrfToken }),
  listPeople: (signal?: AbortSignal) => request<Person[]>("/api/v1/people", { signal }),
  getPerson: (id: string, signal?: AbortSignal) =>
    request<Person>(`/api/v1/people/${encodeURIComponent(id)}`, { signal }),
  createPerson: (
    body: {
      name: string;
      email?: string;
      teamId?: string;
      deliveryRoleId?: string;
      tagIds?: string[];
      activeFrom: string;
      activeUntil?: string;
      schedule: WeekdaySchedule[];
    },
    csrfToken: string,
  ) => request<Person>("/api/v1/people", { method: "POST", body, csrfToken }),
  updatePerson: (id: string, body: Omit<Person, "id" | "schedules">, csrfToken: string) =>
    request<Person>(`/api/v1/people/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
      csrfToken,
    }),
  archivePerson: (id: string, rowVersion: number, csrfToken: string) =>
    request<{ ok: true }>(`/api/v1/people/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      body: { rowVersion },
      csrfToken,
    }),
  addWorkSchedule: (
    id: string,
    body: { effectiveFrom: string; effectiveUntil?: string; weekdays: WeekdaySchedule[] },
    csrfToken: string,
  ) =>
    request<WorkSchedule>(`/api/v1/people/${encodeURIComponent(id)}/work-schedules`, {
      method: "POST",
      body,
      csrfToken,
    }),
  unassignHolidayCalendar: (personId: string, csrfToken: string) =>
    request<{ ok: true }>(`/api/v1/people/${encodeURIComponent(personId)}/holiday-calendar`, {
      method: "DELETE",
      csrfToken,
    }),
  listProjects: (signal?: AbortSignal) => request<Project[]>("/api/v1/projects", { signal }),
  createProject: (
    body: {
      name: string;
      kind: Project["kind"];
      status: "draft" | "tentative" | "confirmed";
      clientId?: string;
      targetStart?: string;
      targetEnd?: string;
    },
    csrfToken: string,
  ) => request<Project>("/api/v1/projects", { method: "POST", body, csrfToken }),
  updateProject: (
    id: string,
    body: {
      name: string;
      kind: Project["kind"];
      status: "draft" | "tentative" | "confirmed";
      clientId?: string;
      targetStart?: string;
      targetEnd?: string;
      rowVersion: number;
    },
    csrfToken: string,
  ) =>
    request<Project>(`/api/v1/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
      csrfToken,
    }),
  transitionProject: (
    id: string,
    transition: "archive" | "complete",
    rowVersion: number,
    csrfToken: string,
  ) =>
    request<{ ok: true }>(`/api/v1/projects/${encodeURIComponent(id)}/${transition}`, {
      method: "POST",
      body: { rowVersion },
      csrfToken,
    }),
  listAllocations: (start?: string, end?: string, signal?: AbortSignal) =>
    request<Allocation[]>(query("/api/v1/allocations", { start, end }), { signal }),
  createAllocation: (
    body: {
      personId: string;
      projectId: string;
      startDate: string;
      endDate: string;
      mode: Allocation["mode"];
      minutesPerDay?: number;
      capacityPercent?: number;
      state: Allocation["state"];
    },
    csrfToken: string,
  ) => request<Allocation>("/api/v1/allocations", { method: "POST", body, csrfToken }),
  updateAllocation: (id: string, body: Omit<Allocation, "id" | "kind">, csrfToken: string) =>
    request<Allocation>(`/api/v1/allocations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
      csrfToken,
    }),
  deleteAllocation: (id: string, rowVersion: number, csrfToken: string) =>
    request<{ ok: true }>(`/api/v1/allocations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: { rowVersion },
      csrfToken,
    }),
  getSchedule: (start: string, end: string, scenario: Scenario, signal?: AbortSignal) =>
    request<ScheduleResponse>(query("/api/v1/schedule", { start, end, scenario }), { signal }),
  getForecast: (weeks = 13, start?: string, signal?: AbortSignal) =>
    request<ForecastResponse>(query("/api/v1/forecast", { weeks, start }), { signal }),
  findEarliestStart: (
    body: {
      notBefore: string;
      workdayCount: number;
      dailyMinutes: number;
      scenario: Scenario;
      horizonDays: number;
      roleId?: string;
      teamId?: string;
      tags?: string[];
    },
    csrfToken: string,
    signal?: AbortSignal,
  ) =>
    request<EarliestStartResult[]>("/api/v1/earliest-start", {
      method: "POST",
      body,
      csrfToken,
      signal,
    }),
  listConflicts: (start: string, end: string, scenario: Scenario, signal?: AbortSignal) =>
    request<DerivedConflict[]>(query("/api/v1/conflicts", { start, end, scenario }), { signal }),
  acknowledgeConflict: (fingerprint: string, csrfToken: string) =>
    request<{ ok: true }>(`/api/v1/conflicts/${encodeURIComponent(fingerprint)}/acknowledge`, {
      method: "POST",
      csrfToken,
    }),
};
