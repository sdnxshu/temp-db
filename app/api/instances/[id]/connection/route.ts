/**
 * app/api/instances/[id]/connection/route.ts
 *
 * GET /api/instances/:id/connection
 *
 * Returns the full connection details and credentials for a running instance.
 * Intentionally gated behind liveness — credentials are only returned when
 * the instance is confirmed to still be running. Stopped/errored instances
 * return 410 Gone so callers know not to retry with the same credentials.
 *
 * Query params:
 *   format — "url" | "env" | "json" | "all"   (default: "all")
 *             Controls which connection formats are included in the response.
 *
 * Response formats:
 *   url  → a single connection string  (e.g. postgresql://user:pass@host:port/db)
 *   env  → shell export statements     (e.g. DB_HOST=..., DB_PORT=..., etc.)
 *   json → individual fields           (host, port, user, password, dbName)
 *   all  → all three above
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dbInstancesTable } from "@/db/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

type Format = "url" | "env" | "json" | "all";

const VALID_FORMATS: Format[] = ["url", "env", "json", "all"];

interface ConnectionJson {
    host: string;
    port: number;
    dbName: string;
    user: string;
    password: string;
}

interface ConnectionEnv {
    DB_HOST: string;
    DB_PORT: string;
    DB_NAME: string;
    DB_USER: string;
    DB_PASSWORD: string;
    // Driver-specific aliases
    PGHOST?: string;
    PGPORT?: string;
    PGDATABASE?: string;
    PGUSER?: string;
    PGPASSWORD?: string;
    MYSQL_HOST?: string;
    MYSQL_PORT?: string;
    MYSQL_DATABASE?: string;
    MYSQL_USER?: string;
    MYSQL_PASSWORD?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildConnectionUrl(
    dbType: string,
    user: string,
    password: string,
    host: string,
    port: number,
    dbName: string
): string {
    const scheme = dbType === "postgres" ? "postgresql" : "mysql";
    const encodedPassword = encodeURIComponent(password);
    return `${scheme}://${user}:${encodedPassword}@${host}:${port}/${dbName}`;
}

function buildConnectionJson(
    host: string,
    port: number,
    dbName: string,
    user: string,
    password: string
): ConnectionJson {
    return { host, port, dbName, user, password };
}

function buildConnectionEnv(
    dbType: string,
    host: string,
    port: number,
    dbName: string,
    user: string,
    password: string
): ConnectionEnv {
    const base: ConnectionEnv = {
        DB_HOST: host,
        DB_PORT: String(port),
        DB_NAME: dbName,
        DB_USER: user,
        DB_PASSWORD: password,
    };

    // Attach driver-native env var names as aliases
    if (dbType === "postgres") {
        return {
            ...base,
            PGHOST: host,
            PGPORT: String(port),
            PGDATABASE: dbName,
            PGUSER: user,
            PGPASSWORD: password,
        };
    }

    if (dbType === "mysql") {
        return {
            ...base,
            MYSQL_HOST: host,
            MYSQL_PORT: String(port),
            MYSQL_DATABASE: dbName,
            MYSQL_USER: user,
            MYSQL_PASSWORD: password,
        };
    }

    return base;
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
    const { id: instanceId } = await params;

    // ── 1. Parse format param ────────────────────────────────────────────────
    const rawFormat = req.nextUrl.searchParams.get("format") ?? "all";

    if (!VALID_FORMATS.includes(rawFormat as Format)) {
        return NextResponse.json(
            {
                error: "Invalid `format` query param",
                allowed: VALID_FORMATS,
            },
            { status: 400 }
        );
    }

    const format = rawFormat as Format;

    // ── 2. Fetch instance — only the fields we actually need ─────────────────
    const [instance] = await db
        .select({
            id: dbInstancesTable.id,
            dbType: dbInstancesTable.dbType,
            host: dbInstancesTable.host,
            port: dbInstancesTable.port,
            dbName: dbInstancesTable.dbName,
            dbUser: dbInstancesTable.dbUser,
            dbPassword: dbInstancesTable.dbPassword,
            status: dbInstancesTable.status,
            expiresAt: dbInstancesTable.expiresAt,
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

    // ── 3. Guard: only serve credentials for live instances ──────────────────
    if (instance.status === "stopped") {
        return NextResponse.json(
            {
                error: "Instance has been stopped — credentials are no longer valid",
                instanceId,
                status: "stopped",
                destroyedAt: instance.destroyedAt,
            },
            { status: 410 } // 410 Gone — resource existed but is permanently gone
        );
    }

    if (instance.status === "error") {
        return NextResponse.json(
            {
                error: "Instance is in an error state — credentials may no longer be valid",
                instanceId,
                status: "error",
            },
            { status: 409 }
        );
    }

    // ── 4. Guard: TTL expired but status not yet updated (race window) ───────
    const now = Date.now();
    if (instance.expiresAt && instance.expiresAt.getTime() <= now) {
        return NextResponse.json(
            {
                error: "Instance TTL has expired — credentials are no longer valid",
                instanceId,
                expiresAt: instance.expiresAt,
            },
            { status: 410 }
        );
    }

    // ── 5. Build connection formats ───────────────────────────────────────────
    const { dbType, host, port, dbName, dbUser, dbPassword } = instance;

    const url = buildConnectionUrl(dbType, dbUser, dbPassword, host, port, dbName);
    const json = buildConnectionJson(host, port, dbName, dbUser, dbPassword);
    const env = buildConnectionEnv(dbType, host, port, dbName, dbUser, dbPassword);

    const secondsRemaining = Math.max(
        0,
        Math.floor((instance.expiresAt.getTime() - now) / 1000)
    );

    // ── 6. Shape response based on requested format ───────────────────────────
    const connection =
        format === "url" ? { url } :
            format === "env" ? { env } :
                format === "json" ? { json } :
                    { url, env, json };           // "all"

    return NextResponse.json(
        {
            instanceId,
            dbType,
            status: "running",
            expiresAt: instance.expiresAt,
            secondsRemaining,
            connection,
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