import { DBType } from "./types";

export const MAX_TTL_SECONDS = 24 * 60 * 60; // 24 hours
export const MIN_TTL_SECONDS = 60; // 1 minute

export const DB_CONFIG: Record<
    DBType,
    {
        image: string;
        internalPort: number;
        hostPortRange: [number, number];
        envFactory: (opts: { password: string; dbName: string; user: string }) => string[];
        readinessCmd: string[];
    }
> = {
    postgres: {
        image: "postgres:16-alpine",
        internalPort: 5432,
        hostPortRange: [54320, 54420],
        envFactory: ({ password, dbName, user }) => [
            `POSTGRES_PASSWORD=${password}`,
            `POSTGRES_DB=${dbName}`,
            `POSTGRES_USER=${user}`,
        ],
        readinessCmd: ["pg_isready", "-U", "user"],
    },
    mysql: {
        image: "mysql:8.0",
        internalPort: 3306,
        hostPortRange: [33060, 33160],
        envFactory: ({ password, dbName, user }) => [
            `MYSQL_ROOT_PASSWORD=${password}`,
            `MYSQL_DATABASE=${dbName}`,
            `MYSQL_USER=${user}`,
            `MYSQL_PASSWORD=${password}`,
        ],
        readinessCmd: ["mysqladmin", "ping", "-h", "localhost"],
    },
};