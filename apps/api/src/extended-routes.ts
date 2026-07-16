import {
  ClientNameBody,
  ConflictFingerprintParams,
  ConflictQuery,
  EarliestStartBody,
  ForecastQuery,
  HolidayAssignmentBody,
  HolidayCalendarNameBody,
  HolidayDateBody,
  IdParams,
  LeaveEntryBody,
  LeaveRangeQuery,
  LeaveTypeNameBody,
  TagNameBody,
  TeamOrRoleNameBody,
  UpdateClientNameBody,
  UpdateHolidayCalendarNameBody,
  UpdateLeaveEntryBody,
  UpdateLeaveTypeNameBody,
  UpdateTagNameBody,
  UpdateTeamOrRoleNameBody,
  VersionBody,
} from "@agency-workload/contracts";
import { type Static, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionContext } from "./auth-service.js";
import type { CalendarService } from "./calendar-service.js";
import type { CatalogKind, CatalogService } from "./catalog-service.js";
import type { DerivedService } from "./derived-service.js";
import {
  ConflictListResponse,
  commonResponses,
  EarliestListResponse,
  EmptyResponse,
  ForecastResponse,
  HolidayCalendarListResponse,
  HolidayCalendarResponse,
  HolidayDateResponse,
  LeaveEntryResponse,
  LeaveListResponse,
  NamedItemResponse,
  NamedListResponse,
} from "./extended-schemas.js";

interface Dependencies {
  catalog: CatalogService;
  calendar: CalendarService;
  derived: DerivedService;
  sessionFor(request: FastifyRequest): Promise<SessionContext>;
  csrfFor(request: FastifyRequest, session: SessionContext): void;
}

interface NamedCreateBody {
  name: string;
}

interface NamedUpdateBody extends NamedCreateBody {
  rowVersion: number;
}

type CatalogCreateSchema = typeof TeamOrRoleNameBody | typeof TagNameBody;
type CatalogUpdateSchema = typeof UpdateTeamOrRoleNameBody | typeof UpdateTagNameBody;

const HolidayDateParams = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    date: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
  },
  { additionalProperties: false },
);

export function registerExtendedRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  const { catalog, calendar, derived, sessionFor, csrfFor } = dependencies;

  registerNamedCatalog(
    app,
    dependencies,
    "teams",
    "teams",
    TeamOrRoleNameBody,
    UpdateTeamOrRoleNameBody,
  );
  registerNamedCatalog(
    app,
    dependencies,
    "delivery-roles",
    "delivery_roles",
    TeamOrRoleNameBody,
    UpdateTeamOrRoleNameBody,
  );
  registerNamedCatalog(app, dependencies, "tags", "tags", TagNameBody, UpdateTagNameBody);

  app.get(
    "/api/v1/clients",
    { schema: { response: commonResponses(NamedListResponse) } },
    async (request) => catalog.listClients(await sessionFor(request)),
  );
  app.post<{ Body: Static<typeof ClientNameBody> }>(
    "/api/v1/clients",
    { schema: { body: ClientNameBody, response: commonResponses(NamedItemResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      return catalog.createClient(actor, request.body.name);
    },
  );
  app.patch<{ Params: Static<typeof IdParams>; Body: Static<typeof UpdateClientNameBody> }>(
    "/api/v1/clients/:id",
    {
      schema: {
        params: IdParams,
        body: UpdateClientNameBody,
        response: commonResponses(NamedItemResponse),
      },
    },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      return catalog.updateClient(
        actor,
        request.params.id,
        request.body.name,
        request.body.rowVersion,
      );
    },
  );
  app.post<{ Params: Static<typeof IdParams>; Body: Static<typeof VersionBody> }>(
    "/api/v1/clients/:id/archive",
    { schema: { params: IdParams, body: VersionBody, response: commonResponses(EmptyResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      await catalog.archiveClient(actor, request.params.id, request.body.rowVersion);
      return { ok: true as const };
    },
  );

  app.get(
    "/api/v1/holiday-calendars",
    { schema: { response: commonResponses(HolidayCalendarListResponse) } },
    async (request) => calendar.listHolidayCalendars(await sessionFor(request)),
  );
  app.post<{ Body: Static<typeof HolidayCalendarNameBody> }>(
    "/api/v1/holiday-calendars",
    {
      schema: {
        body: HolidayCalendarNameBody,
        response: commonResponses(HolidayCalendarResponse),
      },
    },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      return calendar.createHolidayCalendar(actor, request.body.name);
    },
  );
  app.patch<{
    Params: Static<typeof IdParams>;
    Body: Static<typeof UpdateHolidayCalendarNameBody>;
  }>(
    "/api/v1/holiday-calendars/:id",
    {
      schema: {
        params: IdParams,
        body: UpdateHolidayCalendarNameBody,
        response: commonResponses(HolidayCalendarResponse),
      },
    },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      return calendar.updateHolidayCalendar(
        actor,
        request.params.id,
        request.body.name,
        request.body.rowVersion,
      );
    },
  );
  app.post<{ Params: Static<typeof IdParams>; Body: Static<typeof VersionBody> }>(
    "/api/v1/holiday-calendars/:id/archive",
    { schema: { params: IdParams, body: VersionBody, response: commonResponses(EmptyResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      await calendar.archiveHolidayCalendar(actor, request.params.id, request.body.rowVersion);
      return { ok: true as const };
    },
  );
  app.post<{ Params: Static<typeof IdParams>; Body: Static<typeof HolidayDateBody> }>(
    "/api/v1/holiday-calendars/:id/dates",
    {
      schema: {
        params: IdParams,
        body: HolidayDateBody,
        response: commonResponses(HolidayDateResponse),
      },
    },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      return calendar.addHolidayDate(
        actor,
        request.params.id,
        request.body.date,
        request.body.name,
      );
    },
  );
  app.delete<{ Params: Static<typeof HolidayDateParams> }>(
    "/api/v1/holiday-calendars/:id/dates/:date",
    { schema: { params: HolidayDateParams, response: commonResponses(EmptyResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      await calendar.removeHolidayDate(actor, request.params.id, request.params.date);
      return { ok: true as const };
    },
  );
  app.put<{ Params: Static<typeof IdParams>; Body: Static<typeof HolidayAssignmentBody> }>(
    "/api/v1/people/:id/holiday-calendar",
    {
      schema: {
        params: IdParams,
        body: HolidayAssignmentBody,
        response: commonResponses(EmptyResponse),
      },
    },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      await calendar.assignHolidayCalendar(actor, request.params.id, request.body.calendarId);
      return { ok: true as const };
    },
  );
  app.delete<{ Params: Static<typeof IdParams> }>(
    "/api/v1/people/:id/holiday-calendar",
    { schema: { params: IdParams, response: commonResponses(EmptyResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      await calendar.unassignHolidayCalendar(actor, request.params.id);
      return { ok: true as const };
    },
  );

  app.get(
    "/api/v1/leave-types",
    { schema: { response: commonResponses(NamedListResponse) } },
    async (request) => calendar.listLeaveTypes(await sessionFor(request)),
  );
  registerLeaveTypeMutations(app, dependencies);
  app.get<{ Querystring: Static<typeof LeaveRangeQuery> }>(
    "/api/v1/leave",
    { schema: { querystring: LeaveRangeQuery, response: commonResponses(LeaveListResponse) } },
    async (request) =>
      calendar.listLeave(
        await sessionFor(request),
        request.query.start,
        request.query.end,
        request.query.personId,
      ),
  );
  app.post<{ Body: Static<typeof LeaveEntryBody> }>(
    "/api/v1/leave",
    { schema: { body: LeaveEntryBody, response: commonResponses(LeaveEntryResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      return calendar.createLeave(actor, request.body);
    },
  );
  app.patch<{ Params: Static<typeof IdParams>; Body: Static<typeof UpdateLeaveEntryBody> }>(
    "/api/v1/leave/:id",
    {
      schema: {
        params: IdParams,
        body: UpdateLeaveEntryBody,
        response: commonResponses(LeaveEntryResponse),
      },
    },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      return calendar.updateLeave(actor, request.params.id, request.body);
    },
  );
  app.delete<{ Params: Static<typeof IdParams>; Body: Static<typeof VersionBody> }>(
    "/api/v1/leave/:id",
    { schema: { params: IdParams, body: VersionBody, response: commonResponses(EmptyResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      await calendar.deleteLeave(actor, request.params.id, request.body.rowVersion);
      return { ok: true as const };
    },
  );

  app.get<{ Querystring: Static<typeof ConflictQuery> }>(
    "/api/v1/conflicts",
    { schema: { querystring: ConflictQuery, response: commonResponses(ConflictListResponse) } },
    async (request) => derived.listConflicts(await sessionFor(request), request.query),
  );
  app.post<{ Params: Static<typeof ConflictFingerprintParams> }>(
    "/api/v1/conflicts/:fingerprint/acknowledge",
    { schema: { params: ConflictFingerprintParams, response: commonResponses(EmptyResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      await derived.acknowledge(actor, request.params.fingerprint);
      return { ok: true as const };
    },
  );
  app.delete<{ Params: Static<typeof ConflictFingerprintParams> }>(
    "/api/v1/conflicts/:fingerprint/acknowledge",
    { schema: { params: ConflictFingerprintParams, response: commonResponses(EmptyResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      await derived.unacknowledge(actor, request.params.fingerprint);
      return { ok: true as const };
    },
  );
  app.post<{ Body: Static<typeof EarliestStartBody> }>(
    "/api/v1/earliest-start",
    { schema: { body: EarliestStartBody, response: commonResponses(EarliestListResponse) } },
    async (request) =>
      derived.earliestStart(await sessionFor(request), {
        ...request.body,
        ...(request.body.tags ? { tagIds: request.body.tags } : {}),
      }),
  );
  app.get<{ Querystring: Static<typeof ForecastQuery> }>(
    "/api/v1/forecast",
    { schema: { querystring: ForecastQuery, response: commonResponses(ForecastResponse) } },
    async (request) =>
      derived.forecast(await sessionFor(request), {
        ...request.query,
        ...(request.query.tagId ? { tagIds: [request.query.tagId] } : {}),
      }),
  );
}

function registerNamedCatalog(
  app: FastifyInstance,
  dependencies: Dependencies,
  path: string,
  kind: CatalogKind,
  createSchema: CatalogCreateSchema,
  updateSchema: CatalogUpdateSchema,
) {
  const { catalog, sessionFor, csrfFor } = dependencies;
  app.get(
    `/api/v1/${path}`,
    { schema: { response: commonResponses(NamedListResponse) } },
    async (request) => catalog.list(await sessionFor(request), kind),
  );
  app.post<{ Body: NamedCreateBody }>(
    `/api/v1/${path}`,
    { schema: { body: createSchema, response: commonResponses(NamedItemResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      return catalog.create(actor, kind, request.body.name);
    },
  );
  app.patch<{ Params: Static<typeof IdParams>; Body: NamedUpdateBody }>(
    `/api/v1/${path}/:id`,
    {
      schema: {
        params: IdParams,
        body: updateSchema,
        response: commonResponses(NamedItemResponse),
      },
    },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      return catalog.update(
        actor,
        kind,
        request.params.id,
        request.body.name,
        request.body.rowVersion,
      );
    },
  );
  app.post<{ Params: Static<typeof IdParams>; Body: Static<typeof VersionBody> }>(
    `/api/v1/${path}/:id/archive`,
    { schema: { params: IdParams, body: VersionBody, response: commonResponses(EmptyResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      await catalog.archive(actor, kind, request.params.id, request.body.rowVersion);
      return { ok: true as const };
    },
  );
}

function registerLeaveTypeMutations(app: FastifyInstance, dependencies: Dependencies) {
  const { calendar, sessionFor, csrfFor } = dependencies;
  app.post<{ Body: Static<typeof LeaveTypeNameBody> }>(
    "/api/v1/leave-types",
    { schema: { body: LeaveTypeNameBody, response: commonResponses(NamedItemResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      return calendar.createLeaveType(actor, request.body.name);
    },
  );
  app.patch<{ Params: Static<typeof IdParams>; Body: Static<typeof UpdateLeaveTypeNameBody> }>(
    "/api/v1/leave-types/:id",
    {
      schema: {
        params: IdParams,
        body: UpdateLeaveTypeNameBody,
        response: commonResponses(NamedItemResponse),
      },
    },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      return calendar.updateLeaveType(
        actor,
        request.params.id,
        request.body.name,
        request.body.rowVersion,
      );
    },
  );
  app.post<{ Params: Static<typeof IdParams>; Body: Static<typeof VersionBody> }>(
    "/api/v1/leave-types/:id/archive",
    { schema: { params: IdParams, body: VersionBody, response: commonResponses(EmptyResponse) } },
    async (request) => {
      const actor = await sessionFor(request);
      csrfFor(request, actor);
      await calendar.archiveLeaveType(actor, request.params.id, request.body.rowVersion);
      return { ok: true as const };
    },
  );
}
