import {
  CreateAllocationBody,
  CreatePersonBody,
  CreateProjectBody,
  DateRangeQuery,
  IdParams,
  LocalDateSchema,
  PlanningSettingsBody,
  UpdateAllocationBody,
  UpdatePersonBody,
  UpdateProjectBody,
  VersionBody,
  WorkScheduleBody,
} from "@agency-workload/contracts";
import { type Static, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionContext } from "./auth-service.js";
import {
  AllocationListResponse,
  AllocationResponse,
  EmptySuccessResponse,
  PersonDetailResponse,
  PersonListResponse,
  PersonResponse,
  PlannerScheduleResponse,
  PlanningSettingsResponse,
  ProjectListResponse,
  ProjectResponse,
  planningResponses,
  WorkScheduleResponse,
} from "./planning-schemas.js";
import type { PlanningService } from "./planning-service.js";

interface RouteDependencies {
  planning: PlanningService;
  sessionFor(request: FastifyRequest): Promise<SessionContext>;
  csrfFor(request: FastifyRequest, session: SessionContext): void;
}

const AllocationQuery = Type.Object(
  { start: Type.Optional(LocalDateSchema), end: Type.Optional(LocalDateSchema) },
  { additionalProperties: false },
);

export function registerPlanningRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): void {
  const { planning, sessionFor, csrfFor } = dependencies;

  app.get(
    "/api/v1/planning/settings",
    { schema: { response: planningResponses(PlanningSettingsResponse) } },
    async (request) => planning.getSettings(await sessionFor(request)),
  );
  app.patch<{ Body: Static<typeof PlanningSettingsBody> }>(
    "/api/v1/planning/settings",
    {
      schema: { body: PlanningSettingsBody, response: planningResponses(PlanningSettingsResponse) },
    },
    async (request) => {
      const session = await sessionFor(request);
      csrfFor(request, session);
      return planning.updateSettings(session, request.body);
    },
  );

  app.get(
    "/api/v1/people",
    { schema: { response: planningResponses(PersonListResponse) } },
    async (request) => planning.listPeople(await sessionFor(request)),
  );
  app.post<{ Body: Static<typeof CreatePersonBody> }>(
    "/api/v1/people",
    { schema: { body: CreatePersonBody, response: planningResponses(PersonResponse) } },
    async (request) => {
      const session = await sessionFor(request);
      csrfFor(request, session);
      const { schedule, ...person } = request.body;
      return planning.createPerson(session, person, schedule);
    },
  );
  app.get<{ Params: Static<typeof IdParams> }>(
    "/api/v1/people/:id",
    { schema: { params: IdParams, response: planningResponses(PersonDetailResponse) } },
    async (request) => planning.getPerson(await sessionFor(request), request.params.id),
  );
  app.patch<{ Params: Static<typeof IdParams>; Body: Static<typeof UpdatePersonBody> }>(
    "/api/v1/people/:id",
    {
      schema: {
        params: IdParams,
        body: UpdatePersonBody,
        response: planningResponses(PersonResponse),
      },
    },
    async (request) => {
      const session = await sessionFor(request);
      csrfFor(request, session);
      return planning.updatePerson(session, request.params.id, request.body);
    },
  );
  app.post<{ Params: Static<typeof IdParams>; Body: Static<typeof VersionBody> }>(
    "/api/v1/people/:id/archive",
    {
      schema: {
        params: IdParams,
        body: VersionBody,
        response: planningResponses(EmptySuccessResponse),
      },
    },
    async (request) => {
      const session = await sessionFor(request);
      csrfFor(request, session);
      await planning.archivePerson(session, request.params.id, request.body.rowVersion);
      return { ok: true as const };
    },
  );
  app.post<{ Params: Static<typeof IdParams>; Body: Static<typeof WorkScheduleBody> }>(
    "/api/v1/people/:id/work-schedules",
    {
      schema: {
        params: IdParams,
        body: WorkScheduleBody,
        response: planningResponses(WorkScheduleResponse),
      },
    },
    async (request) => {
      const session = await sessionFor(request);
      csrfFor(request, session);
      return planning.addWorkSchedule(
        session,
        request.params.id,
        request.body.effectiveFrom,
        request.body.effectiveUntil,
        request.body.weekdays,
      );
    },
  );

  app.get(
    "/api/v1/projects",
    { schema: { response: planningResponses(ProjectListResponse) } },
    async (request) => planning.listProjects(await sessionFor(request)),
  );
  app.post<{ Body: Static<typeof CreateProjectBody> }>(
    "/api/v1/projects",
    { schema: { body: CreateProjectBody, response: planningResponses(ProjectResponse) } },
    async (request) => {
      const session = await sessionFor(request);
      csrfFor(request, session);
      return planning.createProject(session, request.body);
    },
  );
  app.get<{ Params: Static<typeof IdParams> }>(
    "/api/v1/projects/:id",
    { schema: { params: IdParams, response: planningResponses(ProjectResponse) } },
    async (request) => planning.getProject(await sessionFor(request), request.params.id),
  );
  app.patch<{ Params: Static<typeof IdParams>; Body: Static<typeof UpdateProjectBody> }>(
    "/api/v1/projects/:id",
    {
      schema: {
        params: IdParams,
        body: UpdateProjectBody,
        response: planningResponses(ProjectResponse),
      },
    },
    async (request) => {
      const session = await sessionFor(request);
      csrfFor(request, session);
      return planning.updateProject(session, request.params.id, request.body);
    },
  );
  for (const transition of ["archive", "complete"] as const) {
    app.post<{ Params: Static<typeof IdParams>; Body: Static<typeof VersionBody> }>(
      `/api/v1/projects/:id/${transition}`,
      {
        schema: {
          params: IdParams,
          body: VersionBody,
          response: planningResponses(EmptySuccessResponse),
        },
      },
      async (request) => {
        const session = await sessionFor(request);
        csrfFor(request, session);
        if (transition === "archive") {
          await planning.archiveProject(session, request.params.id, request.body.rowVersion);
        } else {
          await planning.completeProject(session, request.params.id, request.body.rowVersion);
        }
        return { ok: true as const };
      },
    );
  }

  app.get<{ Querystring: Static<typeof AllocationQuery> }>(
    "/api/v1/allocations",
    {
      schema: { querystring: AllocationQuery, response: planningResponses(AllocationListResponse) },
    },
    async (request) =>
      planning.listAllocations(await sessionFor(request), request.query.start, request.query.end),
  );
  app.post<{ Body: Static<typeof CreateAllocationBody> }>(
    "/api/v1/allocations",
    { schema: { body: CreateAllocationBody, response: planningResponses(AllocationResponse) } },
    async (request) => {
      const session = await sessionFor(request);
      csrfFor(request, session);
      return planning.createAllocation(session, request.body);
    },
  );
  app.patch<{ Params: Static<typeof IdParams>; Body: Static<typeof UpdateAllocationBody> }>(
    "/api/v1/allocations/:id",
    {
      schema: {
        params: IdParams,
        body: UpdateAllocationBody,
        response: planningResponses(AllocationResponse),
      },
    },
    async (request) => {
      const session = await sessionFor(request);
      csrfFor(request, session);
      return planning.updateAllocation(session, request.params.id, request.body);
    },
  );
  app.delete<{ Params: Static<typeof IdParams>; Body: Static<typeof VersionBody> }>(
    "/api/v1/allocations/:id",
    {
      schema: {
        params: IdParams,
        body: VersionBody,
        response: planningResponses(EmptySuccessResponse),
      },
    },
    async (request) => {
      const session = await sessionFor(request);
      csrfFor(request, session);
      await planning.deleteAllocation(session, request.params.id, request.body.rowVersion);
      return { ok: true as const };
    },
  );

  app.get<{ Querystring: Static<typeof DateRangeQuery> }>(
    "/api/v1/schedule",
    {
      schema: { querystring: DateRangeQuery, response: planningResponses(PlannerScheduleResponse) },
    },
    async (request) =>
      planning.getSchedule(
        await sessionFor(request),
        request.query.start,
        request.query.end,
        request.query.scenario,
      ),
  );
}
