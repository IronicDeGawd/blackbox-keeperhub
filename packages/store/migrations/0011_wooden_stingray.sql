CREATE TABLE IF NOT EXISTS "webhook_secrets" (
	"secret_hash" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_secrets_org_idx" ON "webhook_secrets" USING btree ("org_id");