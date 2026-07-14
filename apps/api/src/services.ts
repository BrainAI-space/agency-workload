import { Pool } from "pg";
import { AdminService } from "./admin-service.js";
import { AuthService } from "./auth-service.js";
import { CalendarService } from "./calendar-service.js";
import { CatalogService } from "./catalog-service.js";
import type { AppConfig } from "./config.js";
import { DerivedService } from "./derived-service.js";
import { GoTrueClient } from "./gotrue-client.js";
import { FixedSmtpMailer } from "./mailer.js";
import { PlanningService } from "./planning-service.js";

export interface ApplicationServices {
  auth: Pick<
    AuthService,
    "csrfToken" | "getSession" | "logout" | "requestCode" | "verifyCode" | "verifyCsrf"
  >;
  admin: Pick<
    AdminService,
    | "changeRole"
    | "createInvitation"
    | "deactivate"
    | "listInvitations"
    | "listMemberships"
    | "readAudit"
    | "resendInvitation"
    | "revokeSession"
  >;
  planning: PlanningService;
  catalog: CatalogService;
  calendar: CalendarService;
  derived: DerivedService;
  close(): Promise<void>;
}

export function createApplicationServices(config: AppConfig): ApplicationServices {
  if (config.environment === "production") {
    throw new Error("Production mail delivery is not enabled in this milestone");
  }
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const gotrue = new GoTrueClient(config.gotrueOrigin, config.gotrueServiceRoleKey);
  const mailer = new FixedSmtpMailer(config.smtp);
  const auth = new AuthService(pool, config, gotrue, mailer);
  const admin = new AdminService(pool, auth);
  const planning = new PlanningService(pool);
  const catalog = new CatalogService(pool);
  const calendar = new CalendarService(pool);
  const derived = new DerivedService(pool);
  return { auth, admin, planning, catalog, calendar, derived, close: () => pool.end() };
}
