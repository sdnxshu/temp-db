import { NextRequest, NextResponse } from "next/server";

import { randomBytes } from "crypto";
import Docker from "dockerode";

import { db } from "@/db";
import { dbInstancesTable } from "@/db/schema";

import { docker } from "@/lib/docker";
import { scheduleDestroy } from "@/lib/queue";

import { findFreePort } from "@/utils/find-free-port";

import { MIN_TTL_SECONDS, MAX_TTL_SECONDS, DB_CONFIG } from "@/constants";
import { ContainerMeta, CreateRequestBody, DBType } from "@/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSecret(length = 24): string {
    return randomBytes(length).toString("hex");
}

function generateId(): string {
    return randomBytes(8).toString("hex");
}

/** Persist container metadata to postgres. */
async function saveMeta(meta: ContainerMeta): Promise<void> {
    await db.insert(dbInstancesTable).values(meta);
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
    // 1. Parse & validate request body
    let body: Partial<CreateRequestBody>;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { db, ttl } = body;

    if (!db || !["postgres", "mysql"].includes(db)) {
        return NextResponse.json(
            { error: "Field `db` must be one of: postgres, mysql" },
            { status: 400 }
        );
    }

    if (typeof ttl !== "number" || !Number.isInteger(ttl)) {
        return NextResponse.json(
            { error: "Field `ttl` must be an integer (seconds)" },
            { status: 400 }
        );
    }

    if (ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
        return NextResponse.json(
            {
                error: `Field \`ttl\` must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS} seconds (max 24h)`,
            },
            { status: 400 }
        );
    }

    const dbType = db as DBType;
    const config = DB_CONFIG[dbType];

    // 2. Generate credentials
    const instanceId = generateId();
    const dbPassword = generateSecret();
    const dbUser = dbType === "postgres" ? "pguser" : "mysqluser";
    const dbName = `db_${instanceId}`;

    // 3. Pull image if not already present (non-blocking check)
    try {
        await docker.getImage(config.image).inspect();
    } catch {
        // Image not found locally — pull it
        await new Promise<void>((resolve, reject) => {
            docker.pull(config.image, (err: Error | null, stream: NodeJS.ReadableStream) => {
                if (err) return reject(err);
                docker.modem.followProgress(stream, (progressErr: Error | null) => {
                    if (progressErr) return reject(progressErr);
                    resolve();
                });
            });
        });
    }

    // 4. Find a free host port
    let hostPort: number;
    try {
        hostPort = await findFreePort(...config.hostPortRange);
    } catch (err) {
        console.error("[create] Port exhaustion:", err);
        return NextResponse.json(
            { error: "No available ports. Try again shortly." },
            { status: 503 }
        );
    }

    // 5. Create and start the container
    let container: Docker.Container;
    try {
        container = await docker.createContainer({
            Image: config.image,
            name: `ephemeral-${dbType}-${instanceId}`,
            Env: config.envFactory({ password: dbPassword, dbName, user: dbUser }),
            Labels: {
                "ephemeral-db": "true",
                "ephemeral-db.instance-id": instanceId,
                "ephemeral-db.type": dbType,
                "ephemeral-db.expires-at": new Date(Date.now() + ttl * 1000).toISOString(),
            },
            HostConfig: {
                PortBindings: {
                    [`${config.internalPort}/tcp`]: [{ HostPort: String(hostPort) }],
                },
                // Sensible resource limits
                Memory: 512 * 1024 * 1024, // 512 MB
                NanoCpus: 1_000_000_000,   // 1 vCPU
                AutoRemove: false,          // Worker handles removal
                NetworkMode: "bridge",
            },
            ExposedPorts: {
                [`${config.internalPort}/tcp`]: {},
            },
        });

        await container.start();
    } catch (err) {
        console.error("[create] Container start error:", err);
        return NextResponse.json(
            { error: "Failed to start database container", detail: String(err) },
            { status: 500 }
        );
    }

    const containerInfo = await container.inspect();
    const containerId = containerInfo.Id;
    const dockerHost = process.env.DOCKER_HOST_IP ?? "localhost";

    // 6. Persist metadata
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const meta: ContainerMeta = {
        id: instanceId,
        containerId,
        dbType,
        host: dockerHost,
        port: hostPort,
        dbName,
        dbUser,
        dbPassword,
        ttl,
        expiresAt,
        createdAt: now,
        status: "running",
    };

    try {
        // await ensureSchema();
        await saveMeta(meta);
    } catch (err) {
        // Metadata save failed — stop and remove the container to avoid orphans
        console.error("[create] Metadata persistence failed, rolling back container:", err);
        await container.stop().catch(() => { });
        await container.remove().catch(() => { });
        return NextResponse.json(
            { error: "Failed to persist instance metadata", detail: String(err) },
            { status: 500 }
        );
    }

    // 7. Enqueue delayed destroy job
    let jobId: string;
    try {
        jobId = await scheduleDestroy(meta);
    } catch (err) {
        // Non-fatal: log and continue — operator can manually clean up or re-enqueue
        console.error("[create] Failed to enqueue destroy job:", err);
        jobId = "enqueue-failed";
    }

    // 8. Build connection string
    const connectionString =
        dbType === "postgres"
            ? `postgresql://${dbUser}:${dbPassword}@${dockerHost}:${hostPort}/${dbName}`
            : `mysql://${dbUser}:${dbPassword}@${dockerHost}:${hostPort}/${dbName}`;

    // 9. Return response
    return NextResponse.json(
        {
            success: true,
            instance: {
                id: instanceId,
                dbType,
                host: dockerHost,
                port: hostPort,
                dbName,
                dbUser,
                dbPassword,
                connectionString,
                ttl,
                expiresAt: expiresAt.toISOString(),
                createdAt: now.toISOString(),
            },
            job: {
                id: jobId,
                queue: "destroy-containers",
                scheduledFor: expiresAt.toISOString(),
            },
        },
        { status: 201 }
    );
}

