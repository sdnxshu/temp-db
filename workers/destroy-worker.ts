import { Worker, Job, UnrecoverableError } from "bullmq";
import { eq } from "drizzle-orm";

import { closeDb, db } from "@/db";
import { dbInstancesTable } from "@/db/schema";

import { docker } from "@/lib/docker";
import { DestroyJobPayload } from "@/types";

// ─── Config ───────────────────────────────────────────────────────────────────

const QUEUE_NAME = "destroy-containers";
const JOB_NAME = "destroy-container";

// How long to wait for container stop before forcibly killing it (seconds)
const STOP_TIMEOUT_SECONDS = 10;

/** Structured log helper — keeps output consistent and easy to grep. */
function log(
    level: "info" | "warn" | "error",
    jobId: string,
    instanceId: string,
    message: string,
    extra?: Record<string, unknown>
) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        jobId,
        instanceId,
        message,
        ...extra,
    };
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(JSON.stringify(entry));
}

/**
 * Update the instance status and destroyed_at timestamp via Drizzle.
 */
async function updateInstanceStatus(
    instanceId: string,
    status: "running" | "stopped" | "error",
    destroyedAt: Date
): Promise<void> {
    await db
        .update(dbInstancesTable)
        .set({ status, destroyedAt })
        .where(eq(dbInstancesTable.id, instanceId));
}

/**
 * Stop a container, tolerating the case where it is already stopped.
 * Returns true if the stop was issued, false if the container was already not running.
 */
async function stopContainer(containerId: string): Promise<boolean> {
    const container = docker.getContainer(containerId);

    try {
        const info = await container.inspect();

        if (!info.State.Running) {
            return false; // Already stopped — nothing to do
        }

        await container.stop({ t: STOP_TIMEOUT_SECONDS });
        return true;
    } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;

        if (statusCode === 304) return false; // Already stopped
        if (statusCode === 404) return false; // Container gone — treat as cleaned up

        throw err; // Unexpected — let BullMQ retry
    }
}

/**
 * Remove a container, tolerating the case where it no longer exists.
 * Returns true if removed, false if it was already gone.
 */
async function removeContainer(containerId: string): Promise<boolean> {
    const container = docker.getContainer(containerId);

    try {
        await container.remove({ force: true, v: true }); // v: also removes anonymous volumes
        return true;
    } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;

        if (statusCode === 404) return false; // Already removed — idempotent

        throw err;
    }
}

// ─── Core Job Processor ───────────────────────────────────────────────────────

async function processDestroyJob(job: Job<DestroyJobPayload>): Promise<void> {
    const { instanceId, containerId, dbType } = job.data;
    const jobId = job.id ?? "unknown";

    log("info", jobId, instanceId, "Starting container teardown", {
        containerId,
        dbType,
        attempt: job.attemptsMade + 1,
    });

    // ── Step 1: Stop the container ────────────────────────────────────────────
    let stopped: boolean;
    try {
        stopped = await stopContainer(containerId);
        log("info", jobId, instanceId, stopped ? "Container stopped" : "Container was already stopped", { containerId });
    } catch (err) {
        log("error", jobId, instanceId, "Failed to stop container", { containerId, error: String(err) });
        throw err;
    }

    // ── Step 2: Remove the container ─────────────────────────────────────────
    let removed: boolean;
    try {
        removed = await removeContainer(containerId);
        log("info", jobId, instanceId, removed ? "Container removed" : "Container was already removed", { containerId });
    } catch (err) {
        log("error", jobId, instanceId, "Failed to remove container", { containerId, error: String(err) });
        throw err;
    }

    // ── Step 3: Update metadata via Drizzle ──────────────────────────────────
    try {
        await updateInstanceStatus(instanceId, "stopped", new Date());
        log("info", jobId, instanceId, "Instance status updated to 'stopped'");
    } catch (err) {
        log("error", jobId, instanceId, "Failed to update instance status", { error: String(err) });
        // Container is already gone — retrying will safely re-attempt only the DB write
        throw err;
    }

    log("info", jobId, instanceId, "Teardown complete", { containerId, dbType });
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker<DestroyJobPayload>(
    QUEUE_NAME,
    async (job) => {
        if (job.name !== JOB_NAME) {
            throw new UnrecoverableError(`Unknown job name: ${job.name}`);
        }
        await processDestroyJob(job);
    },
    {
        connection: {
            host: process.env.REDIS_HOST ?? "localhost",
            port: Number(process.env.REDIS_PORT ?? 6379),
            password: process.env.REDIS_PASSWORD,
        },
        concurrency: 10,
        limiter: {
            max: 20,   // Max 20 jobs…
            duration: 1000, // …per second (Docker API rate safety)
        },
    }
);

// ─── Worker Lifecycle Events ──────────────────────────────────────────────────

worker.on("completed", (job) => {
    log("info", job.id ?? "?", job.data.instanceId, "Job completed successfully");
});

worker.on("failed", (job, err) => {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    const exhausted = job.attemptsMade >= maxAttempts;

    log("error", job.id ?? "?", job.data.instanceId, "Job failed", {
        error: err.message,
        attemptsMade: job.attemptsMade,
        willRetry: !exhausted,
    });

    // On final failure, mark the row as 'error' so operators can triage
    if (exhausted) {
        db
            .update(dbInstancesTable)
            .set({ status: "error" })
            .where(eq(dbInstancesTable.id, job.data.instanceId))
            .then(() => {
                log("warn", job.id ?? "?", job.data.instanceId, "Instance marked as 'error' after exhausted retries");
            })
            .catch((drizzleErr: unknown) => {
                log("error", job.id ?? "?", job.data.instanceId, "Could not mark instance as 'error'", {
                    error: String(drizzleErr),
                });
            });
    }
});

worker.on("error", (err) => {
    console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        message: "Worker-level error",
        error: err.message,
    }));
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        message: `Received ${signal}, shutting down gracefully…`,
    }));

    await worker.close(); // Drain in-flight jobs first
    await closeDb();      // Then close the Drizzle/pg pool

    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        message: "Worker shut down cleanly.",
    }));
    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Start ────────────────────────────────────────────────────────────────────

console.log(
    JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        message: "Destroy worker started",
        queue: QUEUE_NAME,
        concurrency: 10,
        redis: `${process.env.REDIS_HOST ?? "localhost"}:${process.env.REDIS_PORT ?? 6379}`,
    })
);