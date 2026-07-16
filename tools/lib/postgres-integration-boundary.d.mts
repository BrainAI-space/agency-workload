export type PostgresIntegrationSuite = "db" | "admin" | "planning" | "extended";

export function assertExactPostgresIntegrationBoundary(
  environment: NodeJS.ProcessEnv,
  expectedSuite: PostgresIntegrationSuite,
): void;

export function runDisposablePostgresSql(
  environment: NodeJS.ProcessEnv,
  expectedSuite: PostgresIntegrationSuite,
  sql: string,
): void;
