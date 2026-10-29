CREATE TYPE "public"."link_mode" AS ENUM('self_provisioned', 'platform_provisioned');--> statement-breakpoint
CREATE TYPE "public"."link_status" AS ENUM('pending', 'awaiting_review', 'active', 'suspended', 'failed');--> statement-breakpoint
ALTER TABLE "whatsapp_links" ADD COLUMN "mode" "link_mode" DEFAULT 'self_provisioned' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_links" ADD COLUMN "status" "link_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_links" ADD COLUMN "display_name_status" text;--> statement-breakpoint
ALTER TABLE "whatsapp_links" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_links_phone_number_idx" ON "whatsapp_links" USING btree ("phone_number_id");