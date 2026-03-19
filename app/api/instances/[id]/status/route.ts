/**
 * app/api/instances/[id]/status/route.ts
 *
 * GET /api/instances/:id/status
 *
 * Returns a live health snapshot for an ephemeral DB instance by hitting
 * the Docker daemon directly, then reconciling against the Postgres record.
 *
 * This is intentionally separate from GET /api/instances/:id — that route
 * returns stored metadata. This one tells you what's *actually* happening
 * right now: is the container running, restarting, OOM-killed, paused, etc.
 *
 * It also self-heals: if Docker says the container is gone but our DB record
 * still says "running", it updates the record to "error" automatically.
 */

import { NextRequest, NextResponse } from "next/server";
import Docker from "dockerode";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dbInstancesTable } from "@/db/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none";

type LiveContainerStatus =
    | "running"
    | "paused"
    | "restarting"
    | "exited"
    | "dead"
    | "created"
    | "removing"
    | "not_found"; // Docker 404 — container was removed outside our control

interface LiveSnapshot {
    // What Docker reports
    containerStatus: LiveContainerStatus;
    containerHealth: ContainerHealth;
    pid: number | null;
    exitCode: number | null;
    oomKilled: boolean;
    restartCount: number;
    startedAt: string | null;
    finishedAt: string | null;
    // What our DB says
    recordStatus: "running" | "stopped" | "error";
    // Derived
    drift: boolean; // true when DB and Docker disagree
    secondsRemaining: number | null;
}

// ─── Singletons ───────────────────────────────────────────────────────────────

const docker = new Docker({
    socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map Docker's raw container state into our LiveContainerStatus union.
 * Docker statuses: created | restarting | running | removing | paused | exited | dead
 */
function mapDockerStatus(state: Docker.ContainerInspectInfo["State"]): LiveContainerStatus {
    if (state.Running) return "running";
    if (state.Paused) return "paused";
    if (state.Restarting) return "restarting";
    if (state.Dead) return "dead";
    if (state.Status) return state.Status as LiveContainerStatus;
    return "exited";
}

/**
 * Map Docker's health status string to our ContainerHealth union.
 * Only set when a HEALTHCHECK is defined in the image.
 */
function mapHealthStatus(health: Docker.ContainerInspectInfo["State"]["Health"]): ContainerHealth {
    if (!health) return "none";
    switch (health.Status) {
        case "healthy": return "healthy";
        case "unhealthy": return "unhealthy";
        case "starting": return "starting";
        default: return "none";
    }
}

/**
 * Parse a Docker timestamp string ("0001-01-01T00:00:00Z" means never set).
 * Returns null for zero/empty values.
 */
function parseDockerTime(raw: string | undefined): string | null {
    if (!raw || raw.startsWith("0001-01-01")) return null;
    return raw;
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
    const { id: instanceId } = await params;

    // ── 1. Fetch DB record ───────────────────────────────────────────────────
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

    const now = Date.now();

    // ── 2. Query Docker for live state ───────────────────────────────────────
    let liveSnapshot: LiveSnapshot;

    try {
        const container = docker.getContainer(instance.containerId);
        const info = await container.inspect();
        const state = info.State;

        const containerStatus = mapDockerStatus(state);
        const containerHealth = mapHealthStatus(state.Health);

        const secondsRemaining =
            instance.status === "running" && instance.expiresAt
                ? Math.max(0, Math.floor((instance.expiresAt.getTime() - now) / 1000))
                : null;

        // Drift = DB says running but container isn't, or vice versa
        const dbSaysRunning = instance.status === "running";
        const dockerSaysRunning = containerStatus === "running" || containerStatus === "restarting";
        const drift = dbSaysRunning !== dockerSaysRunning;

        liveSnapshot = {
            containerStatus,
            containerHealth,
            pid: state.Pid ?? null,
            exitCode: state.ExitCode ?? null,
            oomKilled: state.OOMKilled ?? false,
            restartCount: info.RestartCount ?? 0,
            startedAt: parseDockerTime(state.StartedAt),
            finishedAt: parseDockerTime(state.FinishedAt),
            recordStatus: instance.status,
            drift,
            secondsRemaining,
        };

        // ── 3. Self-heal: if drift detected, reconcile the DB record ────────────
        if (drift && dbSaysRunning && !dockerSaysRunning) {
            // Container exited/died but DB still says "running" — fix it
            await db
                .update(dbInstancesTable)
                .set({
                    status: "error",
                    destroyedAt: new Date(),
                })
                .where(eq(dbInstancesTable.id, instanceId));

            liveSnapshot.recordStatus = "error";
        }
    } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;

        if (statusCode === 404) {
            // Docker has no record of this container — it was removed externally

            // Self-heal: mark as error in DB if still showing running
            if (instance.status === "running") {
                await db
                    .update(dbInstancesTable)
                    .set({
                        status: "error",
                        destroyedAt: new Date(),
                    })
                    .where(eq(dbInstancesTable.id, instanceId));
            }

            liveSnapshot = {
                containerStatus: "not_found",
                containerHealth: "none",
                pid: null,
                exitCode: null,
                oomKilled: false,
                restartCount: 0,
                startedAt: null,
                finishedAt: null,
                recordStatus: instance.status === "running" ? "error" : instance.status,
                drift: instance.status === "running", // was drifted before we fixed it
                secondsRemaining: null,
            };
        } else {
            // Docker daemon unreachable or other unexpected error
            return NextResponse.json(
                {
                    error: "Failed to query Docker daemon",
                    instanceId,
                    containerId: instance.containerId,
                    detail: String(err),
                },
                { status: 502 }
            );
        }
    }

    // ── 4. Build response ────────────────────────────────────────────────────
    return NextResponse.json(
        {
            instanceId,
            containerId: instance.containerId,
            dbType: instance.dbType,
            expiresAt: instance.expiresAt,
            checkedAt: new Date(now).toISOString(),
            live: liveSnapshot,
        },
        { status: 200 }
    );
}

// export async function POST() {
// return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
// }

// export async function DELETE() {
// return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
// }