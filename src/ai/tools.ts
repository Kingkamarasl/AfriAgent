import { and, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { businessFacts, products, type FactTopic } from "@/db/schema";
import type { ToolSchema } from "./provider";

/**
 * The tool allowlist.
 *
 * Two invariants, both structural rather than prompted:
 *
 *  1. **`tenantId` is never a tool argument.** It is injected by the caller
 *     from the verified session. The model physically cannot ask for another
 *     business's data, because there is no parameter through which to ask.
 *
 *  2. **Every tool is typed and validated.** Zod rejects malformed arguments
 *     before any query runs, and the model receives the error so it can
 *     recover. There is no path from model output to a raw SQL string.
 *
 * A tool never returns prose. It returns facts, each carrying its id, tier
 * and topic, so the grounding layer can decide what the model is allowed to
 * say about them.
 */

export interface ToolContext {
  /** From the session. Never from the model. */
  tenantId: string;
}

export interface ToolFact {
  /**
   * The fact's identity. The model writes it as `[fact:<id>]`, so the id
   * itself must NOT carry a `fact:` prefix -- that marker belongs to the
   * citation syntax, not to the id.
   */
  id: string;
  topic: string;
  tier: "authoritative" | "informational";
  subject: string;
  value: string;
}

export interface ToolResult {
  facts: ToolFact[];
  data?: Record<string, unknown>;
  /** Set when the tool knows the honest answer is "we don't have that". */
  notFound?: boolean;
}

export interface ToolDefinition {
  schema: ToolSchema;
  run(ctx: ToolContext, args: unknown): Promise<ToolResult>;
}

/** Facts the model may state as truth. */
const AUTHORITATIVE_FACT: ToolFact["tier"] = "authoritative";

/* ------------------------------------------------------------------ */
/* Shared query                                                        */
/* ------------------------------------------------------------------ */

/**
 * Loads facts for a tenant.
 *
 * `active` only. A draft fact is invisible to the model, which is what makes
 * "publish a fact" a deliberate act rather than a write.
 */
async function loadFacts(
  tenantId: string,
  topics: FactTopic[],
  subjectContains?: string,
): Promise<ToolFact[]> {
  const db = await getDb();
  if (topics.length === 0) return [];

  const conds = [
    eq(businessFacts.tenantId, tenantId),
    eq(businessFacts.status, "active"),
    sql`${businessFacts.topic} in ${topics}`,
  ];

  if (subjectContains) {
    const escaped = subjectContains.replace(/[%_]/g, (c) => `\\${c}`);
    conds.push(ilike(businessFacts.subject, `%${escaped}%`));
  }

  const rows = await db
    .select({
      id: businessFacts.id,
      topic: businessFacts.topic,
      tier: businessFacts.tier,
      subject: businessFacts.subject,
      value: businessFacts.value,
    })
    .from(businessFacts)
    .where(and(...conds))
    .limit(25);

  return rows.map((r) => ({
    id: r.id,
    topic: r.topic,
    tier: r.tier,
    subject: r.subject,
    value: r.value,
  }));
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const priceArgs = z.object({ query: z.string().min(1).max(120) });

const priceTool: ToolDefinition = {
  schema: {
    name: "look_up_price",
    description:
      "Look up the official price of a product or service. Returns the " +
      "business's recorded price only. Never estimate, and never answer " +
      "from memory.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product or service name" },
      },
      required: ["query"],
    },
  },
  async run(ctx, args) {
    const { query } = priceArgs.parse(args);

    // Recorded price facts first, then live product rows. A product without a
    // fact may still carry a price in the catalogue; neither is optional.
    const facts = await loadFacts(ctx.tenantId, ["price"], query);

    const db = await getDb();
    const productsForTenant = await db
      .select({
        id: products.id,
        name: products.name,
        unitPriceMinor: products.unitPriceMinor,
        stockQty: products.stockQty,
        currency: sql<string>`coalesce((select currency from tenants where id = ${ctx.tenantId}), 'NGN')`,
      })
      .from(products)
      .where(
        and(
          eq(products.tenantId, ctx.tenantId),
          eq(products.isActive, true),
          or(
            ilike(products.name, `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`),
            ilike(products.sku, `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`),
          ),
        ),
      )
      .limit(5);

    const productFacts: ToolFact[] = productsForTenant.map((p) => ({
      id: `product:${p.id}`,
      topic: "price",
      // A catalogue row is the business's own system of record, so it is
      // quotable -- but it is still cited, so an audit can trace the number.
      tier: AUTHORITATIVE_FACT,
      subject: p.name,
      value: `${(p.unitPriceMinor / 100).toFixed(2)} ${p.currency}`,
    }));

    const all = [...facts, ...productFacts];
    return {
      facts: all,
      notFound: all.length === 0,
      data: { query, matches: all.length },
    };
  },
};

const stockArgs = z.object({ query: z.string().min(1).max(120) });

const stockTool: ToolDefinition = {
  schema: {
    name: "check_stock",
    description:
      "Check current stock for a product. Returns the live quantity on hand.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product name or SKU" },
      },
      required: ["query"],
    },
  },
  async run(ctx, args) {
    const { query } = stockArgs.parse(args);
    const db = await getDb();
    const escaped = query.replace(/[%_]/g, (c) => `\\${c}`);

    const rows = await db
      .select({
        id: products.id,
        name: products.name,
        unit: products.unit,
        stockQty: products.stockQty,
        reorderLevel: products.reorderLevel,
      })
      .from(products)
      .where(
        and(
          eq(products.tenantId, ctx.tenantId),
          eq(products.isActive, true),
          or(
            ilike(products.name, `%${escaped}%`),
            ilike(products.sku, `%${escaped}%`),
          ),
        ),
      )
      .limit(5);

    return {
      facts: rows.map((p) => ({
        id: `product:${p.id}`,
        topic: "service",
        tier: AUTHORITATIVE_FACT,
        subject: p.name,
        value: `${p.stockQty} ${p.unit} on hand`,
      })),
      notFound: rows.length === 0,
      data: { query, matches: rows.length },
    };
  },
};

const hoursTool: ToolDefinition = {
  schema: {
    name: "check_opening_hours",
    description: "Get the business's opening hours.",
    parameters: { type: "object", properties: {} },
  },
  async run(ctx) {
    const facts = await loadFacts(ctx.tenantId, ["hours"]);
    return { facts, notFound: facts.length === 0 };
  },
};

const businessInfoTool: ToolDefinition = {
  schema: {
    name: "get_business_info",
    description:
      "Get the business's location, contact details and the services it offers.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["location", "contact", "service", "delivery"],
        },
      },
    },
  },
  async run(ctx, args) {
    const parsed = z
      .object({ topic: z.enum(["location", "contact", "service", "delivery"]).optional() })
      .parse(args);
    const topics: FactTopic[] = parsed.topic ? [parsed.topic] : ["location", "contact", "service", "delivery"];
    const facts = await loadFacts(ctx.tenantId, topics);
    return { facts, notFound: facts.length === 0 };
  },
};

const policyTool: ToolDefinition = {
  schema: {
    name: "get_policy",
    description:
      "Get a published business policy: returns, cancellations, payment terms, " +
      "delivery. Only published policies are returned.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", enum: ["policy", "delivery"] },
      },
    },
  },
  async run(ctx, args) {
    const parsed = z
      .object({ topic: z.enum(["policy", "delivery"]).optional() })
      .parse(args);
    const topics: FactTopic[] = parsed.topic ? [parsed.topic] : ["policy", "delivery"];
    const facts = await loadFacts(ctx.tenantId, topics);
    return { facts, notFound: facts.length === 0 };
  },
};

const escalateTool: ToolDefinition = {
  schema: {
    name: "escalate_to_human",
    description:
      "Hand the conversation to a human. Use whenever the answer is not " +
      "recorded above, the customer is unhappy, or the request is sensitive.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why a human is needed" },
      },
      required: ["reason"],
    },
  },
  async run(_ctx, args) {
    const { reason } = z.object({ reason: z.string().min(1).max(300) }).parse(args);
    // Deliberately returns no facts: escalation is an outcome, not an answer.
    return { facts: [], data: { escalated: true, reason } };
  },
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const TOOLS: Record<string, ToolDefinition> = {
  look_up_price: priceTool,
  check_stock: stockTool,
  check_opening_hours: hoursTool,
  get_business_info: businessInfoTool,
  get_policy: policyTool,
  escalate_to_human: escalateTool,
};

export const TOOL_SCHEMAS: ToolSchema[] = Object.values(TOOLS).map((t) => t.schema);

/**
 * Runs a model-requested tool.
 *
 * Unknown tool names and invalid arguments come back as a result the model can
 * read and recover from, never as a thrown exception -- an open model will
 * occasionally invent a tool name, and that is a conversation, not a crash.
 */
export async function runTool(
  name: string,
  ctx: ToolContext,
  args: unknown,
): Promise<{ ok: true; result: ToolResult } | { ok: false; error: string }> {
  const tool = TOOLS[name];
  if (!tool) {
    return {
      ok: false,
      error: `No such tool "${name}". Available: ${Object.keys(TOOLS).join(", ")}.`,
    };
  }

  try {
    return { ok: true, result: await tool.run(ctx, args) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "tool failed",
    };
  }
}
