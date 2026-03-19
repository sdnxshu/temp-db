/**
 * app/api/instances/route.ts
 *
 * GET /api/instances
 *
 * Returns a paginated, filterable list of ephemeral DB instances.
 *
 * Query params:
 *   status   — "running" | "stopped" | "error"          (repeatable: ?status=running&status=error)
 *   db       — "postgres" | "mysql"                      (repeatable: ?db=postgres&db=mysql)
 *   page     — page number, 1-indexed                    (default: 1)
 *   limit    — items per page, max 100                   (default: 20)
 *   sort     — "createdAt" | "expiresAt" | "status"      (default: "createdAt")
 *   order    — "asc" | "desc"                            (default: "desc")
 *   expiring — if present, only return instances expiring within N seconds
 *
 * Example:
 *   GET /api/instances?status=running&db=postgres&sort=expiresAt&order=asc&limit=10
 *   GET /api/instances?expiring=300   ← expiring in the next 5 minutes
 */

import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, gt, inArray, lte, SQL } from "drizzle-orm";
import { db } from "@/db";
import { dbInstancesTable } from "@/db/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_STATUSES = ["running", "stopped", "error"] as const;
const VALID_DB_TYPES = ["postgres", "mysql"] as const;
const VALID_SORT_KEYS = ["createdAt", "expiresAt", "status"] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type Status = (typeof VALID_STATUSES)[number];
type DBType = (typeof VALID_DB_TYPES)[number];
type SortKey = (typeof VALID_SORT_KEYS)[number];

// Map sort key names → Drizzle column references
const SORT_COLUMN_MAP = {
    createdAt: dbInstancesTable.createdAt,
    expiresAt: dbInstancesTable.expiresAt,
    status: dbInstancesTable.status,
} satisfies Record<SortKey, unknown>;

// ─── Param Parsing ────────────────────────────────────────────────────────────

interface ParsedParams {
    statuses: Status[] | null;
    dbTypes: DBType[] | null;
    page: number;
    limit: number;
    sort: SortKey;
    order: "asc" | "desc";
    expiringWithin: number | null; // seconds
}

interface ParseError {
    field: string;
    message: string;
}

function parseParams(url: URL): { params: ParsedParams } | { errors: ParseError[] } {
    const errors: ParseError[] = [];
    const q = url.searchParams;

    // ── status (multi-value) ──
    const rawStatuses = q.getAll("status");
    let statuses: Status[] | null = null;
    if (rawStatuses.length > 0) {
        const invalid = rawStatuses.filter((s) => !VALID_STATUSES.includes(s as Status));
        if (invalid.length > 0) {
            errors.push({ field: "status", message: `Invalid value(s): ${invalid.join(", ")}. Must be one of: ${VALID_STATUSES.join(", ")}` });
        } else {
            statuses = rawStatuses as Status[];
        }
    }

    // ── db (multi-value) ──
    const rawDbs = q.getAll("db");
    let dbTypes: DBType[] | null = null;
    if (rawDbs.length > 0) {
        const invalid = rawDbs.filter((d) => !VALID_DB_TYPES.includes(d as DBType));
        if (invalid.length > 0) {
            errors.push({ field: "db", message: `Invalid value(s): ${invalid.join(", ")}. Must be one of: ${VALID_DB_TYPES.join(", ")}` });
        } else {
            dbTypes = rawDbs as DBType[];
        }
    }

    // ── page ──
    const rawPage = q.get("page") ?? "1";
    const page = parseInt(rawPage, 10);
    if (isNaN(page) || page < 1) {
        errors.push({ field: "page", message: "Must be a positive integer" });
    }

    // ── limit ──
    const rawLimit = q.get("limit") ?? String(DEFAULT_LIMIT);
    const limit = parseInt(rawLimit, 10);
    if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
        errors.push({ field: "limit", message: `Must be an integer between 1 and ${MAX_LIMIT}` });
    }

    // ── sort ──
    const rawSort = q.get("sort") ?? "createdAt";
    if (!VALID_SORT_KEYS.includes(rawSort as SortKey)) {
        errors.push({ field: "sort", message: `Must be one of: ${VALID_SORT_KEYS.join(", ")}` });
    }
    const sort = rawSort as SortKey;

    // ── order ──
    const rawOrder = q.get("order") ?? "desc";
    if (rawOrder !== "asc" && rawOrder !== "desc") {
        errors.push({ field: "order", message: 'Must be "asc" or "desc"' });
    }
    const order = rawOrder as "asc" | "desc";

    // ── expiring ──
    const rawExpiring = q.get("expiring");
    let expiringWithin: number | null = null;
    if (rawExpiring !== null) {
        const n = parseInt(rawExpiring, 10);
        if (isNaN(n) || n < 1) {
            errors.push({ field: "expiring", message: "Must be a positive integer (seconds)" });
        } else {
            expiringWithin = n;
        }
    }

    if (errors.length > 0) return { errors };

    return {
        params: {
            statuses,
            dbTypes,
            page,
            limit,
            sort,
            order,
            expiringWithin,
        },
    };
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
    const parsed = parseParams(new URL(req.url));

    if ("errors" in parsed) {
        return NextResponse.json(
            { error: "Invalid query parameters", details: parsed.errors },
            { status: 400 }
        );
    }

    const { statuses, dbTypes, page, limit, sort, order, expiringWithin } = parsed.params;

    // ── Build WHERE clauses ──────────────────────────────────────────────────
    const conditions: SQL[] = [];

    if (statuses && statuses.length > 0) {
        conditions.push(
            statuses.length === 1
                ? eq(dbInstancesTable.status, statuses[0])
                : inArray(dbInstancesTable.status, statuses)
        );
    }

    if (dbTypes && dbTypes.length > 0) {
        conditions.push(
            dbTypes.length === 1
                ? eq(dbInstancesTable.dbType, dbTypes[0])
                : inArray(dbInstancesTable.dbType, dbTypes)
        );
    }

    if (expiringWithin !== null) {
        const cutoff = new Date(Date.now() + expiringWithin * 1000);
        // Only running instances that expire before the cutoff
        conditions.push(
            eq(dbInstancesTable.status, "running"),
            lte(dbInstancesTable.expiresAt, cutoff),
            gt(dbInstancesTable.expiresAt, new Date()),
        );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // ── Sort ─────────────────────────────────────────────────────────────────
    const sortCol = SORT_COLUMN_MAP[sort];
    const orderExpr = order === "asc" ? asc(sortCol) : desc(sortCol);

    // ── Paginate ─────────────────────────────────────────────────────────────
    const offset = (page - 1) * limit;

    // ── Query: data + total count in parallel ────────────────────────────────
    const [rows, [{ count }]] = await Promise.all([
        db
            .select({
                id: dbInstancesTable.id,
                containerId: dbInstancesTable.containerId,
                dbType: dbInstancesTable.dbType,
                host: dbInstancesTable.host,
                port: dbInstancesTable.port,
                dbName: dbInstancesTable.dbName,
                dbUser: dbInstancesTable.dbUser,
                ttl: dbInstancesTable.ttl,
                status: dbInstancesTable.status,
                expiresAt: dbInstancesTable.expiresAt,
                createdAt: dbInstancesTable.createdAt,
                destroyedAt: dbInstancesTable.destroyedAt,
                // Computed: seconds remaining (null if already stopped/expired)
                // Raw SQL via Drizzle sql`` tag for the interval arithmetic
            })
            .from(dbInstancesTable)
            .where(where)
            .orderBy(orderExpr)
            .limit(limit)
            .offset(offset),

        db
            .select({ count: db.$count(dbInstancesTable, where) })
            .from(dbInstancesTable)
            .where(where),
    ]);

    const total = Number(count);
    const totalPages = Math.ceil(total / limit);
    const now = Date.now();

    // Attach a `secondsRemaining` field — convenient for callers
    const instances = rows.map((row) => ({
        ...row,
        // Credentials intentionally excluded — use GET /api/instances/:id/connection
        secondsRemaining:
            row.status === "running" && row.expiresAt
                ? Math.max(0, Math.floor((row.expiresAt.getTime() - now) / 1000))
                : null,
    }));

    return NextResponse.json(
        {
            data: instances,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
            },
            filters: {
                statuses: statuses ?? "all",
                dbTypes: dbTypes ?? "all",
                expiringWithin: expiringWithin ?? null,
            },
        },
        { status: 200 }
    );
}

// export async function DELETE() {
// return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
// }

// export async function POST() {
// return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
// }