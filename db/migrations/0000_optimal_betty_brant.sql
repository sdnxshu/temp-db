CREATE TYPE "public"."db_type" AS ENUM('postgres', 'mysql');--> statement-breakpoint
CREATE TYPE "public"."instance_status" AS ENUM('running', 'stopped', 'error');--> statement-breakpoint
CREATE TABLE "db_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"container_id" text NOT NULL,
	"db_type" "db_type" NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"db_name" text NOT NULL,
	"db_user" text NOT NULL,
	"db_password" text NOT NULL,
	"ttl" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"destroyed_at" timestamp with time zone,
	"status" "instance_status" DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
