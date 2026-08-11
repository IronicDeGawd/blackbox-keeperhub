CREATE TABLE IF NOT EXISTS "agent_owners" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_owners_org_idx" ON "agent_owners" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_sessions_key_idx" ON "org_sessions" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_sessions_org_idx" ON "org_sessions" USING btree ("org_id");