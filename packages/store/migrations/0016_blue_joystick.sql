ALTER TABLE "remediation_ledger" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "remediation_ledger" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "remediation_ledger" ADD COLUMN "entry_hash" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remediation_ledger_seq_idx" ON "remediation_ledger" USING btree ("seq");