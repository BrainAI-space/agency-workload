import { type Static, Type } from "@sinclair/typebox";

const Email = Type.String({
  maxLength: 254,
  minLength: 3,
  pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
});
const NonBlankName = (maxLength: number) =>
  Type.String({
    minLength: 1,
    maxLength,
    pattern: "^(?=[\\s\\S]*\\S)[\\s\\S]+$",
  });
export const RoleSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("admin"),
  Type.Literal("planner"),
  Type.Literal("member"),
  Type.Literal("viewer"),
]);
export type AppRole = Static<typeof RoleSchema>;

export const RequestCodeBody = Type.Object({ email: Email }, { additionalProperties: false });
export const VerifyCodeBody = Type.Object(
  { email: Email, code: Type.String({ pattern: "^[0-9]{6}$" }) },
  { additionalProperties: false },
);
export const GenericAuthResponse = Type.Object(
  { message: Type.Literal("If an active account exists, a code will be sent.") },
  { additionalProperties: false },
);
export const SessionResponse = Type.Object(
  {
    authenticated: Type.Boolean(),
    csrfToken: Type.Optional(Type.String()),
    user: Type.Optional(
      Type.Object(
        {
          id: Type.String({ format: "uuid" }),
          organizationId: Type.String({ format: "uuid" }),
          role: RoleSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const CreateInvitationBody = Type.Object(
  { email: Email, role: RoleSchema },
  { additionalProperties: false },
);
export const ChangeRoleBody = Type.Object({ role: RoleSchema }, { additionalProperties: false });
export const IdParams = Type.Object(
  { id: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export const EmptyResponse = Type.Object(
  { ok: Type.Literal(true) },
  { additionalProperties: false },
);

export const LocalDateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
export const RowVersionSchema = Type.Integer({ minimum: 1 });
export const UuidSchema = Type.String({ format: "uuid" });
export const ScenarioSchema = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("confirmed_and_tentative"),
]);
export const PlanningSettingsBody = Type.Object(
  {
    timezone: Type.String({ minLength: 1, maxLength: 100 }),
    weekStartsOn: Type.Integer({ minimum: 1, maximum: 7 }),
    dateFormat: Type.Union([
      Type.Literal("DD MMM YYYY"),
      Type.Literal("MMM D, YYYY"),
      Type.Literal("YYYY-MM-DD"),
    ]),
    forecastHorizonWeeks: Type.Integer({ minimum: 13, maximum: 52 }),
    billableTargetPercent: Type.Integer({ minimum: 0, maximum: 100 }),
    rowVersion: RowVersionSchema,
  },
  { additionalProperties: false },
);
export const WeekdayScheduleSchema = Type.Object(
  {
    isoWeekday: Type.Integer({ minimum: 1, maximum: 7 }),
    minutes: Type.Integer({ minimum: 0, maximum: 1440 }),
  },
  { additionalProperties: false },
);
export const CreatePersonBody = Type.Object(
  {
    name: NonBlankName(120),
    email: Type.Optional(Email),
    teamId: Type.Optional(UuidSchema),
    deliveryRoleId: Type.Optional(UuidSchema),
    tagIds: Type.Optional(Type.Array(UuidSchema, { maxItems: 50, uniqueItems: true })),
    activeFrom: LocalDateSchema,
    activeUntil: Type.Optional(LocalDateSchema),
    schedule: Type.Array(WeekdayScheduleSchema, { minItems: 7, maxItems: 7 }),
  },
  { additionalProperties: false },
);
export const UpdatePersonBody = Type.Object(
  {
    name: NonBlankName(120),
    email: Type.Optional(Type.Union([Email, Type.Null()])),
    teamId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    deliveryRoleId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    tagIds: Type.Optional(Type.Array(UuidSchema, { maxItems: 50, uniqueItems: true })),
    activeFrom: LocalDateSchema,
    activeUntil: Type.Optional(Type.Union([LocalDateSchema, Type.Null()])),
    rowVersion: RowVersionSchema,
  },
  { additionalProperties: false },
);
export const WorkScheduleBody = Type.Object(
  {
    effectiveFrom: LocalDateSchema,
    effectiveUntil: Type.Optional(LocalDateSchema),
    weekdays: Type.Array(WeekdayScheduleSchema, { minItems: 7, maxItems: 7 }),
  },
  { additionalProperties: false },
);
export const ProjectKindSchema = Type.Union([Type.Literal("billable"), Type.Literal("internal")]);
export const ProjectStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("tentative"),
  Type.Literal("confirmed"),
  Type.Literal("completed"),
]);
export const CreateProjectBody = Type.Object(
  {
    name: NonBlankName(160),
    kind: ProjectKindSchema,
    status: Type.Union([
      Type.Literal("draft"),
      Type.Literal("tentative"),
      Type.Literal("confirmed"),
    ]),
    clientId: Type.Optional(UuidSchema),
    targetStart: Type.Optional(LocalDateSchema),
    targetEnd: Type.Optional(LocalDateSchema),
  },
  { additionalProperties: false },
);
export const UpdateProjectBody = Type.Object(
  {
    name: NonBlankName(160),
    kind: ProjectKindSchema,
    status: Type.Union([
      Type.Literal("draft"),
      Type.Literal("tentative"),
      Type.Literal("confirmed"),
    ]),
    clientId: Type.Optional(UuidSchema),
    targetStart: Type.Optional(LocalDateSchema),
    targetEnd: Type.Optional(LocalDateSchema),
    rowVersion: RowVersionSchema,
  },
  { additionalProperties: false },
);
export const AllocationModeSchema = Type.Union([
  Type.Literal("minutes_per_day"),
  Type.Literal("capacity_percent"),
]);
export const AllocationStateSchema = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("tentative"),
]);
export const CreateAllocationBody = Type.Object(
  {
    personId: UuidSchema,
    projectId: UuidSchema,
    startDate: LocalDateSchema,
    endDate: LocalDateSchema,
    mode: AllocationModeSchema,
    minutesPerDay: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
    capacityPercent: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    state: AllocationStateSchema,
  },
  { additionalProperties: false },
);
export const UpdateAllocationBody = Type.Object(
  {
    personId: UuidSchema,
    projectId: UuidSchema,
    startDate: LocalDateSchema,
    endDate: LocalDateSchema,
    mode: AllocationModeSchema,
    minutesPerDay: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
    capacityPercent: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    state: AllocationStateSchema,
    rowVersion: RowVersionSchema,
  },
  { additionalProperties: false },
);
export const VersionBody = Type.Object(
  { rowVersion: RowVersionSchema },
  { additionalProperties: false },
);
export const DateRangeQuery = Type.Object(
  { start: LocalDateSchema, end: LocalDateSchema, scenario: ScenarioSchema },
  { additionalProperties: false },
);

const createNameBody = (maxLength: number) =>
  Type.Object({ name: NonBlankName(maxLength) }, { additionalProperties: false });
const updateNameBody = (maxLength: number) =>
  Type.Object(
    { name: NonBlankName(maxLength), rowVersion: RowVersionSchema },
    { additionalProperties: false },
  );
export const TeamOrRoleNameBody = createNameBody(100);
export const UpdateTeamOrRoleNameBody = updateNameBody(100);
export const TagNameBody = createNameBody(60);
export const UpdateTagNameBody = updateNameBody(60);
export const ClientNameBody = createNameBody(120);
export const UpdateClientNameBody = updateNameBody(120);
export const HolidayCalendarNameBody = createNameBody(100);
export const UpdateHolidayCalendarNameBody = updateNameBody(100);
export const LeaveTypeNameBody = createNameBody(80);
export const UpdateLeaveTypeNameBody = updateNameBody(80);
export const HolidayDateBody = Type.Object(
  { date: LocalDateSchema, name: NonBlankName(120) },
  { additionalProperties: false },
);
export const HolidayAssignmentBody = Type.Object(
  { calendarId: UuidSchema },
  { additionalProperties: false },
);
export const LeaveEntryBody = Type.Object(
  {
    personId: UuidSchema,
    leaveTypeId: UuidSchema,
    startDate: LocalDateSchema,
    endDate: LocalDateSchema,
    minutesPerDay: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1, maximum: 1440 }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);
export const UpdateLeaveEntryBody = Type.Object(
  {
    personId: UuidSchema,
    leaveTypeId: UuidSchema,
    startDate: LocalDateSchema,
    endDate: LocalDateSchema,
    minutesPerDay: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1, maximum: 1440 }), Type.Null()]),
    ),
    rowVersion: RowVersionSchema,
  },
  { additionalProperties: false },
);
export const LeaveRangeQuery = Type.Object(
  {
    start: LocalDateSchema,
    end: LocalDateSchema,
    personId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export const ConflictQuery = Type.Object(
  {
    start: LocalDateSchema,
    end: LocalDateSchema,
    scenario: ScenarioSchema,
    personId: Type.Optional(UuidSchema),
    teamId: Type.Optional(UuidSchema),
    roleId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export const ConflictFingerprintParams = Type.Object(
  { fingerprint: Type.String({ minLength: 8, maxLength: 128 }) },
  { additionalProperties: false },
);
export const EarliestStartBody = Type.Object(
  {
    notBefore: LocalDateSchema,
    workdayCount: Type.Integer({ minimum: 1, maximum: 60 }),
    dailyMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
    scenario: ScenarioSchema,
    horizonDays: Type.Integer({ minimum: 1, maximum: 365 }),
    roleId: Type.Optional(UuidSchema),
    teamId: Type.Optional(UuidSchema),
    tags: Type.Optional(Type.Array(UuidSchema, { maxItems: 20, uniqueItems: true })),
  },
  { additionalProperties: false },
);
export const ForecastQuery = Type.Object(
  {
    start: Type.Optional(LocalDateSchema),
    weeks: Type.Optional(Type.Integer({ minimum: 1, maximum: 52 })),
    personId: Type.Optional(UuidSchema),
    teamId: Type.Optional(UuidSchema),
    roleId: Type.Optional(UuidSchema),
    projectId: Type.Optional(UuidSchema),
    tagId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
