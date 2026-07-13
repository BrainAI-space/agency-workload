export interface AppConfig {
  appOrigin: string;
  environment: "development" | "production" | "test";
  databaseUrl: string;
  gotrueOrigin: string;
  gotrueServiceRoleKey: string;
  sessionSecret: string;
  bootstrapEmail?: string;
  smtp: {
    host: string;
    port: number;
    from: string;
    senderName: string;
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = env.APP_ENV ?? "development";
  if (!(["development", "production", "test"] as const).includes(environment as never)) {
    throw new Error("APP_ENV is invalid");
  }
  const bootstrapEmail = env.BOOTSTRAP_EMAIL?.trim();
  return {
    appOrigin: required(env, "APP_ORIGIN"),
    environment: environment as AppConfig["environment"],
    databaseUrl: required(env, "DATABASE_URL"),
    gotrueOrigin: required(env, "GOTRUE_ORIGIN"),
    gotrueServiceRoleKey: required(env, "GOTRUE_SERVICE_ROLE_KEY"),
    sessionSecret: required(env, "SESSION_SECRET"),
    ...(bootstrapEmail ? { bootstrapEmail } : {}),
    smtp: {
      host: env.SMTP_HOST ?? "127.0.0.1",
      port: Number(env.SMTP_PORT ?? 1025),
      from: env.SMTP_FROM ?? "auth@agency-workload.local",
      senderName: env.SMTP_SENDER_NAME ?? "Agency Workload",
    },
  };
}
