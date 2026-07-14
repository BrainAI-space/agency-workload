import { randomUUID } from "node:crypto";
import {
  addDays,
  calculateDay,
  calculateForecastWeek,
  calculateRange,
  deriveConflicts,
  findEarliestStarts,
  formatLocalDate,
  isoWeekday,
  parseLocalDate,
  plannerDateForInstant,
  type Scenario,
} from "@agency-workload/domain";
import type { Pool, PoolClient } from "pg";
import type { SessionContext } from "./auth-service.js";
import { HttpError } from "./errors.js";
import { loadPersonPlans, type PlanFilters } from "./planning-data.js";

const acknowledgeRoles = ["owner", "admin", "planner"] as const;

export interface ConflictFilters extends PlanFilters {
  start: string;
  end: string;
  scenario: Scenario;
}

export interface EarliestRequest extends PlanFilters {
  notBefore: string;
  workdayCount: number;
  dailyMinutes: number;
  scenario: Scenario;
  horizonDays: number;
}

export interface ForecastFilters extends PlanFilters {
  start?: string;
  weeks?: number;
}

export class DerivedService {
  constructor(
    private readonly pool: Pool,
    private readonly instant: () => Date = () => new Date(),
  ) {}

  async listConflicts(actor: SessionContext, filters: ConflictFilters) {
    const start = parseLocalDate(filters.start);
    const end = parseLocalDate(filters.end);
    if (end < start || end - start > 365) throw new HttpError(400, "invalid_date_range");
    const plans = await loadPersonPlans(
      this.pool,
      actor.organizationId,
      filters.start,
      filters.end,
      filters,
    );
    const conflicts = deriveConflicts(
      plans.flatMap((plan) => calculateRange(plan, start, end, filters.scenario)),
    );
    const acknowledgements = await this.pool.query<{
      fingerprint: string;
      acknowledged_by: string;
      acknowledged_at: Date;
    }>(
      `SELECT fingerprint, acknowledged_by, acknowledged_at
       FROM app.conflict_acknowledgements WHERE organization_id = $1`,
      [actor.organizationId],
    );
    const acknowledged = new Map(acknowledgements.rows.map((row) => [row.fingerprint, row]));
    return conflicts.map((conflict) => {
      const acknowledgement = acknowledged.get(conflict.fingerprint);
      return {
        ...conflict,
        date: formatLocalDate(conflict.date),
        source:
          conflict.severity === "confirmed"
            ? "Confirmed allocation demand exceeds effective capacity."
            : "Confirmed and tentative allocation demand exceeds effective capacity.",
        acknowledged: Boolean(acknowledgement),
        acknowledgedBy: acknowledgement?.acknowledged_by ?? null,
        acknowledgedAt: acknowledgement?.acknowledged_at?.toISOString() ?? null,
      };
    });
  }

  async acknowledge(actor: SessionContext, fingerprint: string): Promise<void> {
    this.requireAcknowledge(actor);
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO app.conflict_acknowledgements
         (organization_id, fingerprint, acknowledged_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, fingerprint) DO UPDATE
         SET acknowledged_by = EXCLUDED.acknowledged_by, acknowledged_at = now()`,
        [actor.organizationId, fingerprint, actor.userId],
      );
      await this.audit(client, actor, "conflict.acknowledged", "conflict", null, { fingerprint });
    });
  }

  async unacknowledge(actor: SessionContext, fingerprint: string): Promise<void> {
    this.requireAcknowledge(actor);
    await this.transaction(async (client) => {
      const result = await client.query(
        `DELETE FROM app.conflict_acknowledgements
         WHERE organization_id = $1 AND fingerprint = $2 RETURNING fingerprint`,
        [actor.organizationId, fingerprint],
      );
      if (!result.rowCount) throw new HttpError(404, "conflict_acknowledgement_not_found");
      await this.audit(client, actor, "conflict.unacknowledged", "conflict", null, { fingerprint });
    });
  }

  async earliestStart(actor: SessionContext, request: EarliestRequest) {
    const notBefore = parseLocalDate(request.notBefore);
    if (
      !Number.isInteger(request.workdayCount) ||
      request.workdayCount < 1 ||
      request.workdayCount > 60 ||
      !Number.isInteger(request.dailyMinutes) ||
      request.dailyMinutes < 1 ||
      request.dailyMinutes > 1440 ||
      !Number.isInteger(request.horizonDays) ||
      request.horizonDays < 1 ||
      request.horizonDays > 365
    ) {
      throw new HttpError(400, "invalid_earliest_start_request");
    }
    const end = addDays(notBefore, request.horizonDays - 1);
    const plans = await loadPersonPlans(
      this.pool,
      actor.organizationId,
      request.notBefore,
      formatLocalDate(end),
      request,
    );
    return findEarliestStarts(plans, {
      notBefore,
      workdayCount: request.workdayCount,
      dailyLoadMinutes: request.dailyMinutes,
      scenario: request.scenario,
      horizonDays: request.horizonDays,
      ...(request.roleId ? { roleId: request.roleId } : {}),
      ...(request.teamId ? { teamId: request.teamId } : {}),
      ...(request.tagIds ? { tags: request.tagIds } : {}),
    }).map((result) => {
      const plan = plans.find((candidate) => candidate.id === result.personId);
      if (!plan) throw new Error("Earliest-start result person is unavailable");
      const headrooms: number[] = [];
      for (let date = result.start; date <= result.end; date = addDays(date, 1)) {
        const day = calculateDay(plan, date, request.scenario);
        const available =
          request.scenario === "confirmed"
            ? day.availableConfirmedMinutes
            : day.availableScenarioMinutes;
        if (day.capacityMinutes > 0 && available >= request.dailyMinutes) {
          headrooms.push(available - request.dailyMinutes);
        }
      }
      return {
        personId: result.personId,
        start: formatLocalDate(result.start),
        end: formatLocalDate(result.end),
        minimumHeadroomMinutes: Math.min(...headrooms),
        explanation:
          "Completion includes only qualifying workdays; weekends, holidays, and leave extend the range, and gaps over seven days break a sequence.",
      };
    });
  }

  async forecast(actor: SessionContext, filters: ForecastFilters) {
    const settings = await this.settings(actor.organizationId);
    const weeks = filters.weeks ?? settings.forecast_horizon_weeks;
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52)
      throw new HttpError(400, "invalid_forecast_range");
    const localToday = plannerDateForInstant(this.instant(), settings.timezone);
    const requestedStart = parseLocalDate(filters.start ?? localToday);
    const offset = (isoWeekday(requestedStart) - settings.week_starts_on + 7) % 7;
    const start = addDays(requestedStart, -offset);
    const end = addDays(start, weeks * 7 - 1);
    const plans = await loadPersonPlans(
      this.pool,
      actor.organizationId,
      formatLocalDate(start),
      formatLocalDate(end),
      filters,
    );
    const allDays = plans.flatMap((plan) =>
      calculateRange(plan, start, end, "confirmed_and_tentative"),
    );
    return {
      generatedAt: this.instant().toISOString(),
      timezone: settings.timezone,
      weekStartsOn: settings.week_starts_on,
      assumptions:
        "Advisory forecast from current effective schedules, holidays, leave, and confirmed/tentative allocations. No financial projection or automatic staffing.",
      weeks: Array.from({ length: weeks }, (_, index) => {
        const weekStart = addDays(start, index * 7);
        const weekEnd = addDays(weekStart, 6);
        const forecast = calculateForecastWeek(
          weekStart,
          allDays.filter((day) => day.date >= weekStart && day.date <= weekEnd),
          settings.billable_target_percent,
        );
        return { ...forecast, weekStart: formatLocalDate(forecast.weekStart) };
      }),
    };
  }

  private async settings(organizationId: string) {
    const result = await this.pool.query<{
      timezone: string;
      week_starts_on: number;
      forecast_horizon_weeks: number;
      billable_target_percent: number;
    }>(
      `SELECT timezone, week_starts_on, forecast_horizon_weeks, billable_target_percent
       FROM app.organization_planning_settings WHERE organization_id = $1`,
      [organizationId],
    );
    return (
      result.rows[0] ?? {
        timezone: "UTC",
        week_starts_on: 1,
        forecast_horizon_weeks: 13,
        billable_target_percent: 75,
      }
    );
  }

  private requireAcknowledge(actor: SessionContext): void {
    if (!acknowledgeRoles.includes(actor.role as (typeof acknowledgeRoles)[number])) {
      throw new HttpError(403, "forbidden");
    }
  }

  private async audit(
    client: PoolClient,
    actor: SessionContext,
    action: string,
    targetType: string,
    targetId: string | null,
    details: Record<string, string>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO app.audit_events
       (id, organization_id, actor_user_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), actor.organizationId, actor.userId, action, targetType, targetId, details],
    );
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
