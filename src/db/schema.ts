import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

/** Where a task came from. Matters for billing: schedule != on-demand. */
export const taskOrigin = pgEnum("task_origin", [
  "whatsapp",
  "schedule",
  "dashboard",
  "api",
]);

/**
 * The task lifecycle. Every consequential action in AfriAgent walks this graph.
 *
 *  queued -> running -> draft_ready -> pending_approval -> approved -> sending -> sent
 *                          |                |                  |
 *                          +----------------+------------------+-> cancelled
 *                                                                   |
 *                                                    (any active) -> failed
 */
export const taskStatus = pgEnum("task_status", [
  "queued",
  "running",
  "draft_ready",
  "pending_approval",
  "approved",
  "sending",
  "sent",
  "failed",
  "cancelled",
]);

export const taskKind = pgEnum("task_kind", [
  "sales_report",
  "invoice_reminder",
  "low_stock",
  "daily_summary",
  "customer_question",
  "order_create",
  "appointment_book",
  "handoff",
  "unknown",
]);

export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);

export const messageStatus = pgEnum("message_status", [
  "received",
  "drafted",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
]);

export const invoiceStatus = pgEnum("invoice_status", [
  "draft",
  "sent",
  "overdue",
  "paid",
  "void",
]);

export const orderStatus = pgEnum("order_status", [
  "new",
  "confirmed",
  "fulfilled",
  "cancelled",
]);

export const userRole = pgEnum("user_role", ["owner", "manager", "staff"]);

/* ------------------------------------------------------------------ */
/* Business knowledge (the grounding layer)                            */
/* ------------------------------------------------------------------ */

export const factTopic = pgEnum("fact_topic", [
  "price",
  "service",
  "hours",
  "location",
  "policy",
  "contact",
  "delivery",
  "faq",
]);

/**
 * The single most important distinction in the AI layer.
 *
 * `authoritative` facts are the business's system of record. The model may
 * state them, and every answer that does must cite them.
 *
 * `informational` facts are prose: tone, FAQs, background. The model may read
 * them for context but may never quote them as fact. Asking "what is your
 * return policy?" and answering from a prose FAQ is how a business gets a
 * promise it never made.
 */
export const factTier = pgEnum("fact_tier", ["authoritative", "informational"]);

/** Only `active` facts may be used. Drafts are invisible to the model. */
export const factStatus = pgEnum("fact_status", ["active", "draft", "archived"]);

export const businessFacts = pgTable(
  "business_facts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    topic: factTopic("topic").notNull(),
    tier: factTier("tier").notNull().default("informational"),
    status: factStatus("status").notNull().default("draft"),
    /** What this is about, e.g. "Rice 50kg bag", "Returns", "Opening hours". */
    subject: text("subject").notNull(),
    /** The authoritative content. */
    value: text("value").notNull(),
    /** Machine-readable payload, e.g. { amountMinor, currency } for prices. */
    structured: jsonb("structured").$type<Record<string, unknown>>().notNull().default({}),
    /** Where it came from -- who wrote it, which import, which source. */
    provenance: text("provenance"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("business_facts_tenant_topic_idx").on(t.tenantId, t.topic),
    index("business_facts_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export const handoffStatus = pgEnum("handoff_status", [
  "open",
  "claimed",
  "resolved",
  "expired",
]);

/**
 * A conversation the assistant deliberately did not finish.
 *
 * The grounding layer escalates constantly and by design -- an assistant that
 * guesses is worse than one that hands over. This table is where that
 * handover lands. Without it the agent can give up politely and nobody is ever
 * told, which is the failure mode that loses a shop's trust fastest.
 */
export const handoffs = pgTable(
  "handoffs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The task that triggered the handover, when there was one. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    /** Why the assistant stopped. Specific enough to triage on. */
    reason: text("reason").notNull(),
    /** What was asked, what was tried, what was missing. */
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    status: handoffStatus("status").notNull().default("open"),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("handoffs_tenant_status_idx").on(t.tenantId, t.status),
    index("handoffs_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Platform AI configuration                                            */
/* ------------------------------------------------------------------ */

/**
 * Platform-level settings for the AI layer: default model, budgets, limits.
 * Global, not per-tenant -- tenant admins must never reach provider
 * credentials or platform policy.
 */
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Token accounting for the AI layer.
 *
 * Recorded for cost control and calibration, NOT billed to the customer.
 * The customer is metered per completed task; this exists so the billable
 * weights can eventually be set from measured cost rather than a guess.
 *
 * `costMicros` keeps money in integers (1 USD = 1,000,000 micros), because
 * token costs are fractional and floats must never reach a ledger.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    costMicros: integer("cost_micros").notNull().default(0),
    /** Call index within a single answer, so multi-round tool use is visible. */
    round: integer("round").notNull().default(0),
    /** "ok" | "provider_error" | "budget_exceeded" | "ungrounded" */
    outcome: text("outcome").notNull().default("ok"),
    /** Day key, YYYY-MM-DD, for daily budget enforcement. */
    day: text("day").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_usage_tenant_day_idx").on(t.tenantId, t.day),
    index("ai_usage_day_idx").on(t.day),
  ],
);

/* ------------------------------------------------------------------ */
/* Tenancy + people                                                    */
/* ------------------------------------------------------------------ */

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    country: text("country").notNull().default("NG"),
    currency: text("currency").notNull().default("NGN"),
    timezone: text("timezone").notNull().default("Africa/Lagos"),
    /** Monthly plan in minor units (kobo/cents). NULL = trial / unset. */
    planMonthlyMinor: integer("plan_monthly_minor"),
    /** Included billable units per month; overage is billed per unit. */
    includedUnits: integer("included_units").notNull().default(200),
    /**
     * Price per unit beyond `includedUnits`. Stored per tenant so a price
     * change is a data edit, not a deploy. Kept coherent with
     * planMonthlyMinor / includedUnits by `assertRateCardCoherent`.
     */
    overageRateMinor: integer("overage_rate_minor").notNull().default(7500),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tenants_slug_idx").on(t.slug)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    passwordHash: text("password_hash"),
    role: userRole("role").notNull().default("staff"),
    /** NULL until the address is proven. Blocks password reset until then. */
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("users_tenant_idx").on(t.tenantId), uniqueIndex("users_email_unique_idx").on(t.email)],
);

/**
 * Who supplied the number.
 *
 * Deliberately a *column*, not a branch in the code. The two models stayed
 * undecided long enough that forking on them would have meant rewriting
 * onboarding twice, so both fit here and the decision becomes a per-tenant
 * setting.
 *
 *   self_provisioned     the shop connected its own number (Embedded Signup)
 *   platform_provisioned AfriAgent supplied the number; the shop uses ours
 *
 * Both keep `phoneNumberId -> tenant` resolution intact, because either way a
 * tenant ends up with its own distinct number.
 */
export const linkMode = pgEnum("link_mode", [
  "self_provisioned",
  "platform_provisioned",
]);

/**
 * Connection lifecycle.
 *
 * `awaiting_review` is the state that surprises people: numbers and
 * credentials can be ready while Meta is still reviewing the display name and
 * the shop cannot receive anything. Modelling it explicitly stops it looking
 * like a bug mid-onboarding.
 */
export const linkStatus = pgEnum("link_status", [
  /** Row created, nothing configured yet. */
  "pending",
  /** Numbers and credentials in place, display name not yet approved. */
  "awaiting_review",
  "active",
  /** Meta restricted the account, or the shop churned. */
  "suspended",
  "failed",
]);

/**
 * A WhatsApp Business Account connected to a tenant.
 *
 * Deliberately does *not* hold an access token yet. A single env-var token
 * cannot serve two shops -- Graph API tokens are scoped to the WABAs they were
 * issued for -- so per-tenant credential storage is genuinely unavoidable, but
 * where it should live (encrypted column vs. secrets manager) depends on the
 * BSP, and a half-built column that is always NULL is worse than none: it looks
 * like the problem is solved. That gets built with the provisioning flow.
 */
export const whatsappLinks = pgTable(
  "whatsapp_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    mode: linkMode("mode").notNull().default("self_provisioned"),
    status: linkStatus("status").notNull().default("pending"),

    wabaId: text("waba_id"),
    phoneNumberId: text("phone_number_id"),
    businessPhone: text("business_phone").notNull(),
    displayName: text("display_name"),

    /** Meta's own state for the display name review. */
    displayNameStatus: text("display_name_status"),
    /** Last failure from Meta, shown to whoever is onboarding. */
    lastError: text("last_error"),

    isSimulated: boolean("is_simulated").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("whatsapp_links_tenant_idx").on(t.tenantId),
    // Inbound resolution looks a number up on every webhook, so this index
    // matters more than any other on the table.
    //
    // Nullable, so many not-yet-connected shops can each hold a NULL. Postgres
    // permits that under a unique index. Once set, this is what guarantees one
    // number resolves to exactly one tenant.
    uniqueIndex("whatsapp_links_phone_number_idx").on(t.phoneNumberId),
  ],
);

/** Opaque, hashed session tokens. Raw tokens are only held in HttpOnly cookies. */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("auth_sessions_token_hash_idx").on(t.tokenHash), index("auth_sessions_user_idx").on(t.userId)],
);

/* ------------------------------------------------------------------ */
/* Retail data model (v1 vertical: shops)                              */
/* ------------------------------------------------------------------ */

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Meta `wa_id` -- the addressable WhatsApp identity, not a phone number. */
    waId: text("wa_id").notNull(),
    displayName: text("display_name"),
    phone: text("phone"),
    isBlocked: boolean("is_blocked").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contacts_tenant_wa_idx").on(t.tenantId, t.waId),
    index("contacts_tenant_idx").on(t.tenantId),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull().default("unit"),
    stockQty: integer("stock_qty").notNull().default(0),
    reorderLevel: integer("reorder_level").notNull().default(0),
    /** Minor units. Integers only -- no floats anywhere near money. */
    unitPriceMinor: integer("unit_price_minor").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("products_tenant_sku_idx").on(t.tenantId, t.sku)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    number: text("number").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("NGN"),
    issuedOn: timestamp("issued_on", { withTimezone: true }).notNull().defaultNow(),
    dueOn: timestamp("due_on", { withTimezone: true }),
    status: invoiceStatus("status").notNull().default("sent"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_tenant_number_idx").on(t.tenantId, t.number),
    index("invoices_tenant_status_due_idx").on(t.tenantId, t.status, t.dueOn),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    reference: text("reference").notNull(),
    totalMinor: integer("total_minor").notNull().default(0),
    status: orderStatus("status").notNull().default("new"),
    source: text("source").notNull().default("whatsapp"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_tenant_ref_idx").on(t.tenantId, t.reference),
    index("orders_tenant_placed_idx").on(t.tenantId, t.placedAt),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    /** Snapshot of the name -- products get renamed, orders must not. */
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull().default(0),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

export const authTokenPurpose = pgEnum("auth_token_purpose", [
  "verify_email",
  "password_reset",
]);

/**
 * Single-use tokens for email verification and password recovery.
 *
 * Only the SHA-256 hash is stored, exactly as with sessions: a database leak
 * must not hand an attacker working reset links. `consumedAt` makes them
 * single-use even if the same link is followed twice.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: authTokenPurpose("purpose").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_tokens_hash_idx").on(t.tokenHash),
    index("auth_tokens_user_idx").on(t.userId, t.purpose),
    index("auth_tokens_expiry_idx").on(t.expiresAt),
  ],
);

/**
 * Login attempts, for brute-force protection.
 *
 * The identifier is a SHA-256 hash of the email or IP, never the value
 * itself. Storing raw addresses here would turn a throttling table into a
 * list of every address probed against the system.
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** "email:<hash>" or "ip:<hash>". */
    identifier: text("identifier").notNull(),
    succeeded: boolean("succeeded").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("login_attempts_lookup_idx").on(t.identifier, t.createdAt),
    index("login_attempts_expiry_idx").on(t.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Messaging                                                            */
/* ------------------------------------------------------------------ */

/**
 * One thread per (tenant, contact). `windowExpiresAt` encodes Meta's
 * 24-hour customer service window: free-form text is only legal inside it.
 * Outside the window we must send an approved template. That single column
 * is what keeps us compliant without scattering window maths through the app.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    windowExpiresAt: timestamp("window_expires_at", { withTimezone: true }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("conversations_tenant_contact_idx").on(t.tenantId, t.contactId)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id"),
    direction: messageDirection("direction").notNull(),
    status: messageStatus("status").notNull().default("received"),
    body: text("body").notNull().default(""),
    /** Set when sent outside the CS window. */
    templateName: text("template_name"),
    /** Idempotency key across retries -- Meta will happily double-deliver. */
    dedupeKey: text("dedupe_key"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("messages_dedupe_idx").on(t.dedupeKey),
  ],
);

/* ------------------------------------------------------------------ */
/* The Task engine -- the unit of product                               */
/* ------------------------------------------------------------------ */

/**
 * One Task = one billable, auditable, approvable unit of work.
 *
 * A single inbound WhatsApp message usually fans out into several Tasks
 * ("today's sales, chase overdue invoices, low stock") which is precisely
 * why metering, approval and the audit log are all derived from this table
 * rather than modelled separately.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: taskKind("kind").notNull(),
    origin: taskOrigin("origin").notNull().default("whatsapp"),

    status: taskStatus("status").notNull().default("queued"),

    /** Human-readable label for the dashboard. */
    title: text("title").notNull(),
    /** The verbatim request that produced this task. */
    requestText: text("request_text"),

    /** Structured, tenant-scoped inputs. Shape varies by kind. */
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),

    /** What the agent computed. Shown in the dashboard regardless of delivery. */
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),

    /** The message to deliver, if any. Awaiting approval until signed off. */
    draftBody: text("draft_body"),
    draftRecipientWaId: text("draft_recipient_wa_id"),

    /**
     * Whether a human must sign off before anything leaves the building.
     * Anything that sends money-adjacent or irreversible text defaults true.
     */
    requiresApproval: boolean("requires_approval").notNull().default(true),

    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),

    /** Metering. Units are weighted by kind -- a report costs more than a lookup. */
    billableUnits: integer("billable_units").notNull().default(1),
    isBillable: boolean("is_billable").notNull().default(true),

    /** Set when the task fails, so the UI can offer a retry. */
    error: text("error"),
    attemptCount: integer("attempt_count").notNull().default(0),

    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    /** Groups the Tasks fanned out from one inbound message. */
    conversationTurnId: uuid("conversation_turn_id"),

    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tasks_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("tasks_tenant_status_idx").on(t.tenantId, t.status),
    index("tasks_tenant_kind_idx").on(t.tenantId, t.kind),
    index("tasks_scheduled_idx").on(t.status, t.scheduledFor),
  ],
);

/**
 * Append-only transition log. Doubles as the tenant-facing activity log
 * ("what did the agent do, on whose data, and who signed it off").
 */
export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    fromStatus: taskStatus("from_status"),
    toStatus: taskStatus("to_status").notNull(),
    /** "system" | "whatsapp:<waId>" | "user:<userId>" */
    actor: text("actor").notNull().default("system"),
    note: text("note"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("task_events_task_idx").on(t.taskId, t.createdAt)],
);

/**
 * Append-only billing ledger. Written when a task *completes*, not when it is
 * created -- businesses pay for work delivered. Refunds are negative entries.
 */
export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    kind: taskKind("kind").notNull(),
    units: integer("units").notNull(),
    /** Cost charged in minor units. Derived from units x tenant rate card. */
    amountMinor: integer("amount_minor").notNull().default(0),
    /** Billing period key, e.g. "2026-10". Aggregated per tenant for invoicing. */
    period: text("period").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_tenant_period_idx").on(t.tenantId, t.period),
    index("usage_task_idx").on(t.taskId),
  ],
);

/* ------------------------------------------------------------------ */
/* Relations                                                            */
/* ------------------------------------------------------------------ */

export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  whatsappLinks: many(whatsappLinks),
  contacts: many(contacts),
  products: many(products),
  invoices: many(invoices),
  orders: many(orders),
  tasks: many(tasks),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  tenant: one(tenants, { fields: [contacts.tenantId], references: [tenants.id] }),
  conversations: many(conversations),
  invoices: many(invoices),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  tenant: one(tenants, { fields: [conversations.tenantId], references: [tenants.id] }),
  contact: one(contacts, { fields: [conversations.contactId], references: [contacts.id] }),
  messages: many(messages),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  tenant: one(tenants, { fields: [tasks.tenantId], references: [tenants.id] }),
  events: many(taskEvents),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
  task: one(tasks, { fields: [taskEvents.taskId], references: [tasks.id] }),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));

export type Tenant = typeof tenants.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskEvent = typeof taskEvents.$inferSelect;
export type UsageLedgerEntry = typeof usageLedger.$inferSelect;
export type User = typeof users.$inferSelect;
export type WhatsappLink = typeof whatsappLinks.$inferSelect;
export type AuthTokenPurpose = (typeof authTokenPurpose.enumValues)[number];
export type FactTopic = (typeof factTopic.enumValues)[number];
export type FactTier = (typeof factTier.enumValues)[number];
export type FactStatus = (typeof factStatus.enumValues)[number];
export type BusinessFact = typeof businessFacts.$inferSelect;
export type Handoff = typeof handoffs.$inferSelect;
export type HandoffStatus = (typeof handoffStatus.enumValues)[number];
export type AiUsageEntry = typeof aiUsage.$inferSelect;
export type TaskKind = (typeof taskKind.enumValues)[number];
export type TaskStatus = (typeof taskStatus.enumValues)[number];
export type TaskOrigin = (typeof taskOrigin.enumValues)[number];
