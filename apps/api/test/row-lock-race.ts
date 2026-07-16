import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";

type RaceOperation = () => Promise<unknown>;
type RaceResults = [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];

export type RaceStarter = (
  operations: readonly [RaceOperation, RaceOperation],
) => readonly [Promise<unknown>, Promise<unknown>];

const concurrentRaceStarter: RaceStarter = ([first, second]) => [first(), second()];

export const sequentialRaceStarter: RaceStarter = ([first, second]) => {
  const firstPromise = first();
  return [firstPromise, firstPromise.then(second, second)];
};

async function waitForBlockedChain(pool: Pool, holderPid: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const blocked = await pool.query<{ count: number }>(
      `WITH RECURSIVE blocked(pid) AS (
         SELECT activity.pid
         FROM pg_stat_activity activity
         WHERE $1::integer = ANY(pg_blocking_pids(activity.pid))
         UNION
         SELECT activity.pid
         FROM pg_stat_activity activity
         JOIN blocked blocker ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
       )
       SELECT count(*)::integer AS count FROM blocked`,
      [holderPid],
    );
    if ((blocked.rows[0]?.count ?? 0) >= 2) return;
    await delay(10);
  }
  throw new Error("Race operations did not overlap while the target row lock was held");
}

async function settleWithDeadline(
  promises: readonly [Promise<unknown>, Promise<unknown>],
): Promise<RaceResults> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(promises) as Promise<RaceResults>,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Race operations did not settle")), 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runRowLockRace({
  pool,
  schema,
  table,
  organizationId,
  rowId,
  operations,
  starter = concurrentRaceStarter,
}: {
  pool: Pool;
  schema: "app";
  table: "people" | "projects" | "clients";
  organizationId: string;
  rowId: string;
  operations: readonly [RaceOperation, RaceOperation];
  starter?: RaceStarter;
}): Promise<RaceResults> {
  const holder = await pool.connect();
  let transactionOpen = false;
  try {
    await holder.query("BEGIN");
    transactionOpen = true;
    const locked = await holder.query(
      `SELECT 1 FROM "${schema}"."${table}"
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, rowId],
    );
    if (locked.rowCount !== 1) throw new Error("Race target row unavailable");
    const backend = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const holderPid = backend.rows[0]?.pid;
    if (!holderPid) throw new Error("Race lock holder backend unavailable");

    const invoked = [false, false];
    const settled = [false, false];
    const track =
      (index: 0 | 1): RaceOperation =>
      async () => {
        invoked[index] = true;
        try {
          return await operations[index]();
        } finally {
          settled[index] = true;
        }
      };
    const promises = starter([track(0), track(1)]);
    let proofError: Error | undefined;
    try {
      await waitForBlockedChain(pool, holderPid);
      if (!invoked.every(Boolean) || settled.some(Boolean)) {
        throw new Error(
          "Race operations did not remain pending while the target row lock was held",
        );
      }
    } catch (error) {
      proofError = error instanceof Error ? error : new Error("Race overlap proof failed");
    }

    await holder.query("COMMIT");
    transactionOpen = false;
    const results = await settleWithDeadline(promises);
    if (proofError) throw proofError;
    return results;
  } finally {
    if (transactionOpen) await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
}
