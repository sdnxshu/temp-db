export type DBType = "postgres" | "mysql";

export interface CreateRequestBody {
    db: DBType;
    ttl: number; // seconds, max 86400 (24h)
}

export interface ContainerMeta {
    id: string;
    containerId: string;
    dbType: DBType;
    host: string;
    port: number;
    dbName: string;
    dbUser: string;
    dbPassword: string;
    ttl: number;
    expiresAt: Date;
    createdAt: Date;
    status: "running" | "stopped" | "error";
}

export interface DestroyJobPayload {
    instanceId: string;
    containerId: string;
    dbType: "postgres" | "mysql";
    scheduledAt: string;
}
