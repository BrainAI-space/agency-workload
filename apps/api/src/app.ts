import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import Fastify, { LogController, type FastifyServerOptions } from "fastify";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
}

const HealthResponse = Type.Object({ status: Type.Literal("ok") }, { additionalProperties: false });

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    bodyLimit: 1_048_576,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? true,
    requestTimeout: 15_000,
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie, {
    hook: "onRequest",
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    global: true,
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });

  app.get(
    "/healthz",
    {
      schema: {
        response: { 200: HealthResponse },
      },
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return { status: "ok" } as const;
    },
  );

  return app;
}
