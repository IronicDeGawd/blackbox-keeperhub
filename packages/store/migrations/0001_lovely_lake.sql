CREATE TABLE IF NOT EXISTS "watched_executions" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"signer" text NOT NULL,
	"chain_id" integer NOT NULL,
	"submitted" jsonb,
	"registered_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watched_executions_due_idx" ON "watched_executions" USING btree ("settled_at","last_polled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watched_executions_signer_idx" ON "watched_executions" USING btree ("signer","chain_id");