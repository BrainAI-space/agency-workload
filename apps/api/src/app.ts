import { randomUUID } from "node:crypto";
import {
  ChangeRoleBody,
  CreateInvitationBody,
  EmptyResponse,
  GenericAuthResponse,
  IdParams,
  RequestCodeBody,
  RoleSchema,
  SessionResponse,
  VerifyCodeBody,
} from "@agency-workload/contracts";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyRequest, type FastifyServerOptions, LogController } from "fastify";
import type { SessionContext } from "./auth-service.js";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { registerPlanningRoutes } from "./planning-routes.js";
import type { ApplicationServices } from "./services.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  config?: Pick<AppConfig, "appOrigin" | "environment">;
  services?: ApplicationServices;
}

const HealthResponse = Type.Object({ status: Type.Literal("ok") }, { additionalProperties: false });
const ErrorResponse = Type.Object({ error: Type.String() }, { additionalProperties: false });
const InvitationResponse = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    role: RoleSchema,
    status: Type.Literal("pending"),
    deliveryStatus: Type.Union([
      Type.Literal("pending"),
      Type.Literal("sent"),
      Type.Literal("failed"),
    ]),
  },
  { additionalProperties: false },
);
const InvitationDeliveryResponse = Type.Object(
  {
    deliveryStatus: Type.Union([
      Type.Literal("pending"),
      Type.Literal("sent"),
      Type.Literal("failed"),
    ]),
  },
  { additionalProperties: false },
);
const MembershipListResponse = Type.Array(
  Type.Object(
    {
      userId: Type.String({ format: "uuid" }),
      email: Type.String(),
      role: RoleSchema,
      active: Type.Boolean(),
      createdAt: Type.String(),
    },
    { additionalProperties: false },
  ),
);
const InvitationListResponse = Type.Array(
  Type.Object(
    {
      id: Type.String({ format: "uuid" }),
      email: Type.String(),
      role: RoleSchema,
      status: Type.String(),
      deliveryStatus: Type.Union([
        Type.Literal("pending"),
        Type.Literal("sent"),
        Type.Literal("failed"),
      ]),
      deliveryAttempts: Type.Integer({ minimum: 0 }),
      expiresAt: Type.String(),
      createdAt: Type.String(),
    },
    { additionalProperties: false },
  ),
);
const AuditListResponse = Type.Array(
  Type.Object(
    {
      id: Type.String({ format: "uuid" }),
      actorUserId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
      action: Type.String(),
      targetType: Type.String(),
      targetId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
      details: Type.Record(Type.String(), Type.String()),
      createdAt: Type.String(),
    },
    { additionalProperties: false },
  ),
);
export function sessionCookieName(environment: AppConfig["environment"]): string {
  return environment === "production"
    ? "__Host-agency_workload_session"
    : "agency_workload_session_dev";
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 32_768,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? true,
    requestTimeout: 15_000,
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie, { hook: "onRequest" });
  await app.register(helmet, { contentSecurityPolicy: false, global: true });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    reply.header("cache-control", "no-store");
    return payload;
  });

  if (options.config) {
    app.addHook("onRequest", async (request) => {
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
      if (request.headers.origin !== options.config?.appOrigin)
        throw new HttpError(403, "invalid_origin");
      const contentType = request.headers["content-type"] ?? "";
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)) {
        throw new HttpError(415, "json_required");
      }
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const validation = typeof error === "object" && error !== null && "validation" in error;
    const frameworkStatus =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validation
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus < 500
            ? frameworkStatus
            : 500;
    const publicCode =
      error instanceof HttpError
        ? error.publicCode
        : validation
          ? "invalid_request"
          : statusCode === 429
            ? "rate_limited"
            : "internal_error";
    request.log.warn({ requestId: request.id, statusCode }, "request rejected");
    void reply.status(statusCode).send({ error: publicCode });
  });

  app.get("/healthz", { schema: { response: { 200: HealthResponse } } }, async () => ({
    status: "ok" as const,
  }));

  if (options.services && options.config) {
    const { services } = options;
    const cookieName = sessionCookieName(options.config.environment);
    app.addHook("onClose", () => services.close());
    const cookieOptions = {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: options.config.environment === "production",
      path: "/",
    };
    const sessionFor = async (request: FastifyRequest): Promise<SessionContext> => {
      const session = await services.auth.getSession(request.cookies[cookieName]);
      if (!session) throw new HttpError(401, "unauthenticated");
      return session;
    };
    const csrfFor = (request: FastifyRequest, session: SessionContext): void => {
      const header = request.headers["x-csrf-token"];
      if (typeof header !== "string" || !services.auth.verifyCsrf(session, header)) {
        throw new HttpError(403, "invalid_csrf");
      }
    };

    app.post(
      "/api/v1/auth/request-code",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
          body: RequestCodeBody,
          response: { 202: GenericAuthResponse, 400: ErrorResponse },
        },
      },
      async (request, reply) => {
        const result = await services.auth.requestCode(request.body.email, request.ip);
        return reply.status(202).send(result);
      },
    );
    app.post(
      "/api/v1/auth/verify-code",
      { schema: { body: VerifyCodeBody, response: { 200: SessionResponse, 401: ErrorResponse } } },
      async (request, reply) => {
        const created = await services.auth.verifyCode(request.body.email, request.body.code);
        reply.setCookie(cookieName, created.sessionToken, {
          ...cookieOptions,
          expires: created.context.absoluteExpiresAt,
        });
        return {
          authenticated: true,
          csrfToken: created.csrfToken,
          user: {
            id: created.context.userId,
            organizationId: created.context.organizationId,
            role: created.context.role,
          },
        };
      },
    );
    app.get(
      "/api/v1/auth/session",
      { schema: { response: { 200: SessionResponse } } },
      async (request) => {
        const raw = request.cookies[cookieName];
        const session = await services.auth.getSession(raw);
        if (!session || !raw) return { authenticated: false };
        const csrfToken = services.auth.csrfToken(raw, session);
        return {
          authenticated: true,
          ...(csrfToken ? { csrfToken } : {}),
          user: { id: session.userId, organizationId: session.organizationId, role: session.role },
        };
      },
    );
    app.get(
      "/api/v1/auth/csrf",
      { schema: { response: { 200: SessionResponse } } },
      async (request) => {
        const raw = request.cookies[cookieName];
        const session = await sessionFor(request);
        const csrfToken = raw ? services.auth.csrfToken(raw, session) : null;
        if (!csrfToken) throw new HttpError(401, "unauthenticated");
        return { authenticated: true, csrfToken };
      },
    );
    app.post(
      "/api/v1/auth/logout",
      { schema: { response: { 200: EmptyResponse } } },
      async (request, reply) => {
        const session = await sessionFor(request);
        csrfFor(request, session);
        await services.auth.logout(session);
        reply.clearCookie(cookieName, cookieOptions);
        return { ok: true as const };
      },
    );

    app.get(
      "/api/v1/admin/memberships",
      { schema: { response: { 200: MembershipListResponse } } },
      async (request) => services.admin.listMemberships(await sessionFor(request)),
    );
    app.get(
      "/api/v1/admin/invitations",
      { schema: { response: { 200: InvitationListResponse } } },
      async (request) => services.admin.listInvitations(await sessionFor(request)),
    );
    app.post(
      "/api/v1/admin/invitations",
      { schema: { body: CreateInvitationBody, response: { 200: InvitationResponse } } },
      async (request) => {
        const session = await sessionFor(request);
        csrfFor(request, session);
        return services.admin.createInvitation(
          session,
          request.body.email,
          request.body.role,
          request.ip,
        );
      },
    );
    app.post(
      "/api/v1/admin/invitations/:id/resend",
      { schema: { params: IdParams, response: { 200: InvitationDeliveryResponse } } },
      async (request) => {
        const session = await sessionFor(request);
        csrfFor(request, session);
        return services.admin.resendInvitation(session, request.params.id, request.ip);
      },
    );
    app.patch(
      "/api/v1/admin/memberships/:id/role",
      { schema: { params: IdParams, body: ChangeRoleBody, response: { 200: EmptyResponse } } },
      async (request) => {
        const session = await sessionFor(request);
        csrfFor(request, session);
        await services.admin.changeRole(session, request.params.id, request.body.role);
        return { ok: true as const };
      },
    );
    app.post(
      "/api/v1/admin/memberships/:id/deactivate",
      { schema: { params: IdParams, response: { 200: EmptyResponse } } },
      async (request) => {
        const session = await sessionFor(request);
        csrfFor(request, session);
        await services.admin.deactivate(session, request.params.id);
        return { ok: true as const };
      },
    );
    app.post(
      "/api/v1/admin/sessions/:id/revoke",
      { schema: { params: IdParams, response: { 200: EmptyResponse } } },
      async (request) => {
        const session = await sessionFor(request);
        csrfFor(request, session);
        await services.admin.revokeSession(session, request.params.id);
        return { ok: true as const };
      },
    );
    app.get(
      "/api/v1/admin/audit",
      { schema: { response: { 200: AuditListResponse } } },
      async (request) => services.admin.readAudit(await sessionFor(request)),
    );
    registerPlanningRoutes(app, { planning: services.planning, sessionFor, csrfFor });
  }

  return app;
}
