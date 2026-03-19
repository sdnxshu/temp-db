/**
 * app/api/instances/[id]/route.ts
 *
 * GET    /api/instances/:id  — fetch full metadata for a single instance
 * PATCH  /api/instances/:id  — extend the TTL of a running instance
 * DELETE /api/instances/:id  — manually tear down an instance before TTL
 */

import { NextRequest, NextResponse } from "next/server";
import Docker from "dockerode";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dbInstancesTable } from "@/db/schema";

// ─── Config ───────────────────────────────────────────────────────────────────

const STOP_TIMEOUT_SECONDS = 10;

// ─── Singletons ───────────────────────────────────────────────────────────────

const docker = new Docker({
    socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
});

const destroyQueue = new Queue("db-container-destroy", {
    connection: {
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD,
    },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Stop a container gracefully, then forcibly if needed.
 * Tolerates containers that are already stopped or don't exist.
 */
async function stopContainer(containerId: string): Promise<"stopped" | "already_stopped" | "not_found"> {
    const container = docker.getContainer(containerId);

    try {
        const info = await container.inspect();

        if (!info.State.Running) {
            return "already_stopped";
        }

        await container.stop({ t: STOP_TIMEOUT_SECONDS });
        return "stopped";
    } catch (err: unknown) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 304) return "already_stopped"; // Docker: not modified
        if (code === 404) return "not_found";        // Container never existed / already removed
        throw err;
    }
}

/**
 * Remove a container and its anonymous volumes.
 * Tolerates containers that are already gone.
 */
async function removeContainer(containerId: string): Promise<"removed" | "not_found"> {
    const container = docker.getContainer(containerId);

    try {
        await container.remove({ force: true, v: true });
        return "removed";
    } catch (err: unknown) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404) return "not_found";
        throw err;
    }
}

/**
 * Cancel the pending BullMQ destroy job for this instance.
 * If the job already ran or was already removed, this is a no-op.
 */
async function cancelDestroyJob(instanceId: string): Promise<"cancelled" | "not_found" | "not_cancellable"> {
    const jobId = `destroy:${instanceId}`;
    const job = await destroyQueue.getJob(jobId);

    if (!job) return "not_found";

    // Only cancel if the job hasn't started yet (delayed/waiting state).
    // If it's already active the worker is running — let it finish harmlessly.
    const state = await job.getState();

    if (state === "delayed" || state === "waiting") {
        await job.remove();
        return "cancelled";
    }

    return "not_cancellable"; // active | completed | failed — leave it alone
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
    const { id: instanceId } = await params;

    // ── 1. Fetch the instance record ────────────────────────────────────────
    const [instance] = await db
        .select()
        .from(dbInstancesTable)
        .where(eq(dbInstancesTable.id, instanceId))
        .limit(1);

    if (!instance) {
        return NextResponse.json(
            { error: "Instance not found", instanceId },
            { status: 404 }
        );
    }

    // ── 2. Guard: already torn down ──────────────────────────────────────────
    if (instance.status === "stopped") {
        return NextResponse.json(
            {
                error: "Instance is already stopped",
                instanceId,
                destroyedAt: instance.destroyedAt,
            },
            { status: 409 }
        );
    }

    // ── 3. Stop the container ────────────────────────────────────────────────
    let stopResult: "stopped" | "already_stopped" | "not_found";
    try {
        stopResult = await stopContainer(instance.containerId);
    } catch (err) {
        console.error(`[delete] Failed to stop container ${instance.containerId}:`, err);
        return NextResponse.json(
            {
                error: "Failed to stop container",
                instanceId,
                containerId: instance.containerId,
                detail: String(err),
            },
            { status: 500 }
        );
    }

    // ── 4. Remove the container ──────────────────────────────────────────────
    let removeResult: "removed" | "not_found";
    try {
        removeResult = await removeContainer(instance.containerId);
    } catch (err) {
        console.error(`[delete] Failed to remove container ${instance.containerId}:`, err);
        return NextResponse.json(
            {
                error: "Container stopped but removal failed — retry the request",
                instanceId,
                containerId: instance.containerId,
                detail: String(err),
            },
            { status: 500 }
        );
    }

    // ── 5. Cancel the scheduled BullMQ job ──────────────────────────────────
    let jobResult: "cancelled" | "not_found" | "not_cancellable";
    try {
        jobResult = await cancelDestroyJob(instanceId);
    } catch (err) {
        // Non-fatal: container is already gone. Log and continue.
        console.error(`[delete] Failed to cancel BullMQ job for ${instanceId}:`, err);
        jobResult = "not_found";
    }

    // ── 6. Update Postgres via Drizzle ───────────────────────────────────────
    const destroyedAt = new Date();

    try {
        await db
            .update(dbInstancesTable)
            .set({ status: "stopped", destroyedAt })
            .where(eq(dbInstancesTable.id, instanceId));
    } catch (err) {
        // Container is gone — this is the only thing still at risk.
        // Return a 207 so the caller knows the container is gone but the record is stale.
        console.error(`[delete] Metadata update failed for ${instanceId}:`, err);
        return NextResponse.json(
            {
                warning: "Container destroyed but metadata update failed — record may be stale",
                instanceId,
                containerId: instance.containerId,
                detail: String(err),
            },
            { status: 207 }
        );
    }

    // ── 7. Return summary ────────────────────────────────────────────────────
    return NextResponse.json(
        {
            success: true,
            instanceId,
            containerId: instance.containerId,
            destroyedAt: destroyedAt.toISOString(),
            actions: {
                container: stopResult === "not_found" ? "not_found" : removeResult,
                job: jobResult,
            },
        },
        { status: 200 }
    );
}

// ─── GET /api/instances/:id ───────────────────────────────────────────────────

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
    const { id: instanceId } = await params;

    const [instance] = await db
        .select({
            id: dbInstancesTable.id,
            containerId: dbInstancesTable.containerId,
            dbType: dbInstancesTable.dbType,
            host: dbInstancesTable.host,
            port: dbInstancesTable.port,
            dbName: dbInstancesTable.dbName,
            dbUser: dbInstancesTable.dbUser,
            // dbPassword intentionally omitted — use GET /connection for credentials
            ttl: dbInstancesTable.ttl,
            status: dbInstancesTable.status,
            expiresAt: dbInstancesTable.expiresAt,
            createdAt: dbInstancesTable.createdAt,
            destroyedAt: dbInstancesTable.destroyedAt,
        })
        .from(dbInstancesTable)
        .where(eq(dbInstancesTable.id, instanceId))
        .limit(1);

    if (!instance) {
        return NextResponse.json(
            { error: "Instance not found", instanceId },
            { status: 404 }
        );
    }

    const now = Date.now();

    const secondsRemaining =
        instance.status === "running" && instance.expiresAt
            ? Math.max(0, Math.floor((instance.expiresAt.getTime() - now) / 1000))
            : null;

    return NextResponse.json(
        {
            instance: {
                ...instance,
                secondsRemaining,
                // Convenience links to the two sub-routes callers commonly need next
                links: {
                    status: `/api/instances/${instanceId}/status`,
                    connection: `/api/instances/${instanceId}/connection`,
                },
            },
        },
        { status: 200 }
    );
}

export async function POST() {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}

// ─── PATCH /api/instances/:id ─────────────────────────────────────────────────

/**
 * Extends the TTL of a running instance.
 *
 * Body (JSON):
 *   { "ttlExtension": number }  — additional seconds to add (1–86400)
 *
 * What happens:
 *   1. Validate the instance exists and is running
 *   2. Enforce the absolute ceiling: expiresAt + extension must not exceed
 *      MAX_ABSOLUTE_EXPIRY_HOURS from the original createdAt
 *   3. Update expiresAt in Postgres
 *   4. Reschedule the BullMQ destroy job: remove the old delayed job and
 *      enqueue a new one with the updated delay
 */

const MAX_TTL_EXTENSION_SECONDS = 24 * 60 * 60; // single extension cap: 24h
const MAX_ABSOLUTE_EXPIRY_HOURS = 48;            // hard ceiling from createdAt

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
    const { id: instanceId } = await params;

    // ── 1. Parse & validate body ─────────────────────────────────────────────
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as Record<string, unknown>).ttlExtension !== "number"
    ) {
        return NextResponse.json(
            { error: "Body must be JSON with a numeric `ttlExtension` field (seconds)" },
            { status: 400 }
        );
    }

    const { ttlExtension } = body as { ttlExtension: number };

    if (!Number.isInteger(ttlExtension) || ttlExtension < 1) {
        return NextResponse.json(
            { error: "`ttlExtension` must be a positive integer (seconds)" },
            { status: 400 }
        );
    }

    if (ttlExtension > MAX_TTL_EXTENSION_SECONDS) {
        return NextResponse.json(
            {
                error: `\`ttlExtension\` cannot exceed ${MAX_TTL_EXTENSION_SECONDS} seconds (24h) per request`,
            },
            { status: 400 }
        );
    }

    // ── 2. Fetch the instance ────────────────────────────────────────────────
    const [instance] = await db
        .select()
        .from(dbInstancesTable)
        .where(eq(dbInstancesTable.id, instanceId))
        .limit(1);

    if (!instance) {
        return NextResponse.json(
            { error: "Instance not found", instanceId },
            { status: 404 }
        );
    }

    // ── 3. Guard: must be running ────────────────────────────────────────────
    if (instance.status !== "running") {
        return NextResponse.json(
            {
                error: `Cannot extend TTL of an instance with status '${instance.status}'`,
                status: instance.status,
                instanceId,
            },
            { status: 409 }
        );
    }

    // ── 4. Enforce absolute expiry ceiling ───────────────────────────────────
    const absoluteCeiling = new Date(
        instance.createdAt.getTime() + MAX_ABSOLUTE_EXPIRY_HOURS * 60 * 60 * 1000
    );
    const proposedExpiry = new Date(instance.expiresAt.getTime() + ttlExtension * 1000);

    if (proposedExpiry > absoluteCeiling) {
        const maxAllowedExtension = Math.floor(
            (absoluteCeiling.getTime() - instance.expiresAt.getTime()) / 1000
        );

        if (maxAllowedExtension <= 0) {
            return NextResponse.json(
                {
                    error: "Instance has already reached the maximum allowed lifetime",
                    instanceId,
                    absoluteCeiling: absoluteCeiling.toISOString(),
                    expiresAt: instance.expiresAt.toISOString(),
                },
                { status: 422 }
            );
        }

        return NextResponse.json(
            {
                error: `Requested extension would exceed the ${MAX_ABSOLUTE_EXPIRY_HOURS}h absolute lifetime limit`,
                instanceId,
                maxAllowedExtensionSeconds: maxAllowedExtension,
                absoluteCeiling: absoluteCeiling.toISOString(),
            },
            { status: 422 }
        );
    }

    // ── 5. Reschedule the BullMQ destroy job ─────────────────────────────────
    // Remove the old delayed job first, then re-enqueue with the new delay.
    // Using the same deterministic jobId means if the old job already fired
    // (race between PATCH and TTL expiry), the new one just replaces it safely.
    const oldJobId = `destroy:${instanceId}`;
    const oldJob = await destroyQueue.getJob(oldJobId);

    if (oldJob) {
        const state = await oldJob.getState();
        if (state === "delayed" || state === "waiting") {
            await oldJob.remove();
        }
        // If active/completed/failed, leave it — it'll handle a missing/stopped container gracefully
    }

    const newDelayMs = proposedExpiry.getTime() - Date.now();

    await destroyQueue.add(
        "destroy-container",
        {
            instanceId,
            containerId: instance.containerId,
            dbType: instance.dbType,
            scheduledAt: new Date().toISOString(),
        },
        {
            delay: Math.max(0, newDelayMs),
            attempts: 3,
            backoff: { type: "exponential", delay: 5000 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 50 },
            jobId: oldJobId, // reuse same jobId — idempotent
        }
    );

    // ── 6. Update expiresAt in Postgres ──────────────────────────────────────
    try {
        await db
            .update(dbInstancesTable)
            .set({ expiresAt: proposedExpiry })
            .where(eq(dbInstancesTable.id, instanceId));
    } catch (err) {
        // BullMQ job is already rescheduled — the worker will use the container ID
        // directly, so a stale expiresAt in PG is an inconsistency but not fatal.
        console.error(`[patch] Metadata update failed for ${instanceId}:`, err);
        return NextResponse.json(
            {
                warning: "TTL job rescheduled but metadata update failed — expiresAt may be stale",
                instanceId,
                proposedExpiry: proposedExpiry.toISOString(),
                detail: String(err),
            },
            { status: 207 }
        );
    }

    // ── 7. Return updated state ───────────────────────────────────────────────
    const now = Date.now();
    const secondsRemaining = Math.max(0, Math.floor((proposedExpiry.getTime() - now) / 1000));

    return NextResponse.json(
        {
            success: true,
            instanceId,
            previousExpiresAt: instance.expiresAt.toISOString(),
            expiresAt: proposedExpiry.toISOString(),
            ttlExtension,
            secondsRemaining,
        },
        { status: 200 }
    );
}