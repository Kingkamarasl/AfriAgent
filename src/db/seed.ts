/**
 * Demo data: a small Lagos provisions shop with a week of trading history.
 *
 * This exists so the agent has something real to reason about -- a sales
 * report with a meaningful comparison, invoices that are genuinely overdue,
 * and stock that has genuinely crossed its reorder line.
 *
 * Run with: npm run db:seed
 */
import { getDb } from "./client";
import { migrate } from "./migrate";
import {
  contacts,
  invoices,
  orderItems,
  orders,
  products,
  tasks,
  tenants,
  users,
  whatsappLinks,
} from "./schema";

const OWNER_WA_ID = "2348010000001";
const CURRENCY = "NGN";

/** Naira minor units (kobo). */
const naira = (n: number) => Math.round(n * 100);

const PRODUCTS = [
  { sku: "RICE-50", name: "Rice 50kg bag", unit: "bag", stockQty: 4, reorderLevel: 8, price: naira(48_000) },
  { sku: "OIL-25L", name: "Palm oil 25L", unit: "jerrycan", stockQty: 11, reorderLevel: 10, price: naira(21_500) },
  { sku: "MILK-1L", name: "Peak milk powder 400g", unit: "tin", stockQty: 3, reorderLevel: 12, price: naira(4_200) },
  { sku: "SUG-1KG", name: "Granulated sugar 1kg", unit: "bag", stockQty: 26, reorderLevel: 15, price: naira(1_450) },
  { sku: "TEA-400", name: "Tea bags 100s", unit: "box", stockQty: 9, reorderLevel: 6, price: naira(3_800) },
  { sku: "BREAD-1", name: "Bread loaf", unit: "loaf", stockQty: 18, reorderLevel: 20, price: naira(650) },
  { sku: "EGGS-30", name: "Eggs 30s", unit: "crate", stockQty: 5, reorderLevel: 6, price: naira(9_900) },
  { sku: "SALT-1KG", name: "Salt 1kg", unit: "bag", stockQty: 30, reorderLevel: 10, price: naira(400) },
  { sku: "BLUE-N", name: "Blue Naise powder 2kg", unit: "bag", stockQty: 2, reorderLevel: 8, price: naira(5_900) },
  { sku: "COCA-1.5", name: "Soft drink 1.5L", unit: "bottle", stockQty: 48, reorderLevel: 24, price: naira(750) },
];

const CUSTOMERS = [
  { waId: "2348020000002", name: "Chioma Eze", phone: "+234 802 000 0002" },
  { waId: "2348030000003", name: "Adeyemi Hassan", phone: "+234 803 000 0003" },
  { waId: "2348040000004", name: "Blessing Obi", phone: "+234 804 000 0004" },
  { waId: "2348050000005", name: "Tunde Bakare", phone: "+234 805 000 0005" },
  { waId: "2348060000006", name: "Ngozi Okonkwo", phone: "+234 806 000 0006" },
];

/** Deterministic PRNG so repeated seeds produce identical data. */
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export async function seed() {
  const db = await getDb();
  await migrate();

  console.log("Seeding demo shop...");

  const [existing] = await db.select({ id: tenants.id }).from(tenants).limit(1);
  if (existing) {
    console.log("  tenant already present -- clearing demo data");
    await db.delete(tasks);
    await db.delete(orderItems);
    await db.delete(orders);
    await db.delete(invoices);
    await db.delete(products);
    await db.delete(contacts);
    await db.delete(users);
    await db.delete(whatsappLinks);
    await db.delete(tenants);
  }

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: "Ojota Mini Market",
      slug: "ojota",
      country: "NG",
      currency: CURRENCY,
      timezone: "Africa/Lagos",
      planMonthlyMinor: naira(15_000),
      includedUnits: 200,
    })
    .returning();

  const [owner] = await db
    .insert(users)
    .values({
      tenantId: tenant.id,
      name: "Ngozi Adeyemi",
      phone: OWNER_WA_ID,
      role: "owner",
    })
    .returning();

  await db.insert(users).values({
    tenantId: tenant.id,
    name: "Ibrahim Musa (staff)",
    phone: "2348090000009",
    role: "staff",
  });

  await db.insert(whatsappLinks).values({
    tenantId: tenant.id,
    wabaId: "SIM-WABA-0001",
    phoneNumberId: "SIM_PNID_0001",
    businessPhone: OWNER_WA_ID,
    displayName: "Ojota Mini Market",
    isSimulated: true,
  });

  const productRows = await db
    .insert(products)
    .values(PRODUCTS.map((p) => ({ ...p, tenantId: tenant.id, unitPriceMinor: p.price })))
    .returning();

  const contactRows = await db
    .insert(contacts)
    .values(
      CUSTOMERS.map((c) => ({
        tenantId: tenant.id,
        waId: c.waId,
        displayName: c.name,
        phone: c.phone,
      })),
    )
    .returning();

  const rng = makeRng(20261009);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)];

  // --- Orders: a week of trading, denser today so the report has content ---
  const orderInserts: (typeof orders.$inferInsert)[] = [];
  // Items carry the index of their parent order; ids only exist after insert.
  const itemInserts: Array<
    Omit<typeof orderItems.$inferInsert, "orderId"> & { orderIdx: number }
  > = [];

  for (let daysBack = 6; daysBack >= 0; daysBack--) {
    const perDay = daysBack === 0 ? 9 : 4 + Math.floor(rng() * 4);
    for (let i = 0; i < perDay; i++) {
      const placedAt = new Date(
        Date.now() - daysBack * 86_400_000 - Math.floor(rng() * 8) * 3_600_000,
      );
      const lineCount = 1 + Math.floor(rng() * 3);
      let total = 0;

      const orderIdx = orderInserts.length;
      orderInserts.push({
        tenantId: tenant.id,
        contactId: pick(contactRows).id,
        reference: `ORD-${String(orderIdx + 1).padStart(4, "0")}`,
        totalMinor: 0,
        status: "fulfilled",
        source: daysBack === 0 ? "whatsapp" : "pos",
        placedAt,
      });

      for (let l = 0; l < lineCount; l++) {
        const product = pick(productRows);
        const qty = 1 + Math.floor(rng() * 3);
        total += product.unitPriceMinor * qty;
        itemInserts.push({
          orderIdx,
          tenantId: tenant.id,
          productId: product.id,
          description: product.name,
          quantity: qty,
          unitPriceMinor: product.unitPriceMinor,
        });
      }

      // Line total is only known once every line for this order is counted.
      orderInserts[orderIdx]!.totalMinor = total;
    }
  }

  const insertedOrders = await db.insert(orders).values(orderInserts).returning();

  await db.insert(orderItems).values(
    itemInserts.map(({ orderIdx, ...rest }) => ({
      ...rest,
      orderId: insertedOrders[orderIdx]!.id,
    })),
  );

  // --- Invoices: three genuinely overdue, one just inside terms ---
  const now = Date.now();
  await db.insert(invoices).values([
    {
      tenantId: tenant.id,
      contactId: contactRows[0].id,
      number: "INV-1001",
      amountMinor: naira(96_000),
      currency: CURRENCY,
      issuedOn: new Date(now - 40 * 86_400_000),
      dueOn: new Date(now - 12 * 86_400_000),
      status: "overdue",
    },
    {
      tenantId: tenant.id,
      contactId: contactRows[1].id,
      number: "INV-1002",
      amountMinor: naira(43_500),
      currency: CURRENCY,
      issuedOn: new Date(now - 30 * 86_400_000),
      dueOn: new Date(now - 3 * 86_400_000),
      status: "overdue",
    },
    {
      tenantId: tenant.id,
      contactId: contactRows[2].id,
      number: "INV-1003",
      amountMinor: naira(21_500),
      currency: CURRENCY,
      issuedOn: new Date(now - 18 * 86_400_000),
      dueOn: new Date(now - 1 * 86_400_000),
      status: "sent",
    },
    {
      tenantId: tenant.id,
      contactId: contactRows[3].id,
      number: "INV-1004",
      amountMinor: naira(15_900),
      currency: CURRENCY,
      issuedOn: new Date(now - 5 * 86_400_000),
      dueOn: new Date(now + 9 * 86_400_000),
      status: "sent",
    },
  ]);

  console.log(`  tenant:   ${tenant.name} (${tenant.id})`);
  console.log(`  owner:    ${owner.name} — WhatsApp wa_id ${OWNER_WA_ID}`);
  console.log(`  products: ${productRows.length}`);
  console.log(`  customers:${contactRows.length}`);
  console.log(`  orders:   ${insertedOrders.length}`);
  console.log("");
  console.log("  Simulate an owner message with:");
  console.log(`  curl -X POST http://localhost:3000/api/simulate/inbound \\`);
  console.log(
    `    -H "content-type: application/json" \\`,
  );
  console.log(`    -d '{"from":"${OWNER_WA_ID}","text":"Show me today's sales"}'`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
