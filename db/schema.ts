import { integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const instanceStatusEnum = pgEnum("instance_status", [
    "running",
    "stopped",
    "error",
]);

export const dbTypeEnum = pgEnum("db_type", [
    "postgres",
    "mysql",
]);

export const dbInstancesTable = pgTable("db_instances", {
    id: text("id").primaryKey(),
    containerId: text("container_id").notNull(),

    dbType: dbTypeEnum("db_type").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    dbName: text("db_name").notNull(),
    dbUser: text("db_user").notNull(),
    dbPassword: text("db_password").notNull(),

    ttl: integer("ttl").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    status: instanceStatusEnum("status").notNull().default("running"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DbInstance = typeof dbInstancesTable.$inferSelect;