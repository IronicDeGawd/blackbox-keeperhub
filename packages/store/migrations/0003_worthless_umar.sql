CREATE TABLE IF NOT EXISTS "remediation_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"playbook_id" text NOT NULL,
	"signer" text NOT NULL,
	"chain_id" integer NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"gas_spent_wei" text DEFAULT '0' NOT NULL,
	"status" text NOT NULL,
	"tx_hash" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remediation_ledger_budget_idx" ON "remediation_ledger" USING btree ("signer","chain_id","attempted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remediation_ledger_incident_idx" ON "remediation_ledger" USING btree ("incident_id");