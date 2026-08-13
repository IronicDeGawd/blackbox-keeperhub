CREATE TABLE IF NOT EXISTS "agent_breakers" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"verified_at" timestamp with time zone,
	"registered_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_breakers_org_idx" ON "agent_breakers" USING btree ("org_id");