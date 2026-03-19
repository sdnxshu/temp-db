import { NextRequest, NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { dbInstancesTable } from "@/db/schema";

import { docker } from "@/lib/docker";
import { destroyContainerQueue } from "@/lib/queue";

// ─── Config ───────────────────────────────────────────────────────────────────

const STOP_TIMEOUT_SECONDS = 10;

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
    const jobId = `destroy-${instanceId}`;
    const job = await destroyContainerQueue.getJob(jobId);

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
