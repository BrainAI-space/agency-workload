export function assertDownMigrationAllowed(args: readonly string[], env: NodeJS.ProcessEnv): void {
  if (!args.includes("--confirm-down")) {
    throw new Error("Down migration requires --confirm-down");
  }
  if (env.APP_ENV === "production" && !args.includes("--break-glass-production")) {
    throw new Error("Production down migration requires --break-glass-production");
  }
}
