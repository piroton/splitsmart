/**
 * Group CSV export coverage for non-group-native insertion methods.
 *
 * A member of a group can see EVERY live expense in that group on the group
 * screen (`GET /api/v1/groups/:id/expenses`). Many legitimate workflows put an
 * expense into a group without the exporting member being locked into
 * `expense_users` via the group screen's "+ Expense" dialog:
 *
 *   - moving a 1:1 (non-group) expense into the group (PATCH or sync push)
 *   - moving an expense from another group into this group
 *   - bulk-adding / offline-queueing a group bill for other members (sync push)
 *   - posting via the generic `POST /api/v1/expenses` endpoint with `groupId`
 *   - recording a settle-up or balance-conversion payment between other members
 *   - a guest-link visitor adding an expense or payment in the group
 *   - the recurring scheduler generating an occurrence for other members' template
 *   - transferring/reassigning a member's shares off a group bill (`friend-transfer`)
 *   - importing Splitwise group bills and import-rounding adjustments
 *
 * Every test below verifies that the entry appears in the group listing AND in
 * the group's CSV export (`GET /api/v1/expenses.csv?group_id=<id>`), while
 * preserving access-control boundaries for non-members, former members, and
 * unscoped All-expenses exports.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-group-csv-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db, sqlite } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense } = await import("../../domain/expenses.ts");
const { addFriendship } = await import("../../domain/friends.ts");
const { mintAccessLink } = await import("../../domain/access-links.ts");
const { runDueRecurrences } = await import("../../domain/scheduler.ts");
const { ulid } = await import("../../domain/ulid.ts");

let aliceId: string;
let bobId: string;
let carolId: string;
let ghostId: string;
let outsiderId: string;
let formerId: string;

let flatId: string;
let otherGroupId: string;

let aliceToken: string;
let bobToken: string;
let outsiderToken: string;
let formerToken: string;
let ghostSecret: string;

async function createUser(name: string, email?: string): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({
      id,
      ...(email
        ? { email, password_hash: "scrypt$131072$8$1$AAAA$AAAA", is_ghost: 0 }
        : { is_ghost: 1 }),
      name,
      default_currency: "USD",
    })
    .execute();
  return id;
}

async function createGroup(
  name: string,
  ownerId: string,
  members: Array<{ userId: string; leftAt?: string }>,
): Promise<string> {
  const id = ulid();
  await db
    .insertInto("groups")
    .values({ id, name, default_currency: "USD", created_by: ownerId })
    .execute();
  for (const m of members) {
    await db
      .insertInto("group_members")
      .values({
        group_id: id,
        user_id: m.userId,
        role: m.userId === ownerId ? "owner" : "member",
        joined_via: m.userId === ownerId ? "creator" : "added",
        ...(m.leftAt ? { left_at: m.leftAt } : {}),
      })
      .execute();
  }
  return id;
}

async function apiJson(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** Minimal RFC-4180 CSV parser so tests assert exact column values. */
function parseCsvRecords(csv: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && csv[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else if (ch === '"') {
      quoted = true;
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== "")) rows.push(row);
  }

  const [header, ...dataRows] = rows;
  if (!header) return [];
  return dataRows.map((cells) =>
    Object.fromEntries(header.map((col, idx) => [col, cells[idx] ?? ""])),
  );
}

async function fetchCsvRows(
  path: string,
  token = aliceToken,
): Promise<Array<Record<string, string>>> {
  const res = await app.request(`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, `Expected 200 for ${path}, got ${res.status}`);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  return parseCsvRecords(await res.text());
}

async function groupListDescriptions(groupId: string, token = aliceToken): Promise<string[]> {
  const res = await apiJson(`/groups/${groupId}/expenses?limit=500`, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body.expenses as Array<{ description: string }>).map((e) => e.description);
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  aliceId = await createUser("Alice", "alice@example.com");
  bobId = await createUser("Bob", "bob@example.com");
  carolId = await createUser("Carol", "carol@example.com");
  ghostId = await createUser("Ghost");
  outsiderId = await createUser("Outsider", "outsider@example.com");
  formerId = await createUser("Former", "former@example.com");

  flatId = await createGroup("Flat", aliceId, [
    { userId: aliceId },
    { userId: bobId },
    { userId: carolId },
    { userId: ghostId },
    { userId: formerId, leftAt: "2026-01-15T00:00:00.000Z" },
  ]);
  otherGroupId = await createGroup("Old House", aliceId, [
    { userId: aliceId },
    { userId: bobId },
    { userId: carolId },
  ]);

  await addFriendship(bobId, carolId);

  aliceToken = (await createApiToken(aliceId, "alice")).token;
  bobToken = (await createApiToken(bobId, "bob")).token;
  outsiderToken = (await createApiToken(outsiderId, "outsider")).token;
  formerToken = (await createApiToken(formerId, "former")).token;

  ghostSecret = (
    await mintAccessLink(db, {
      kind: "group_member",
      groupId: flatId,
      userId: ghostId,
      createdBy: aliceId,
    })
  ).secret;

  // Baseline: a directly added group expense where Alice IS a participant (plus
  // the former member before they left), and a 1:1 expense of Alice's own.
  await createExpense({
    groupId: flatId,
    description: "Direct Group Rent",
    costMinor: 120_000,
    currencyCode: "USD",
    date: "2026-01-01",
    splitType: "equal",
    participants: [
      { userId: aliceId, paidMinor: 120_000 },
      { userId: bobId, paidMinor: 0 },
      { userId: formerId, paidMinor: 0 },
    ],
    createdBy: aliceId,
  });

  await createExpense({
    groupId: null,
    description: "Alice Personal Lunch",
    costMinor: 1500,
    currencyCode: "USD",
    date: "2026-01-02",
    splitType: "equal",
    participants: [
      { userId: aliceId, paidMinor: 1500 },
      { userId: bobId, paidMinor: 0 },
    ],
    createdBy: aliceId,
  });
});

after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("group CSV export includes non-group-native insertions", () => {
  test("1:1 non-group expense moved into the group via PATCH /expenses/:id", async () => {
    const created = await apiJson("/expenses", bobToken, {
      method: "POST",
      body: JSON.stringify({
        groupId: null,
        description: "Moved 1:1 Electricity",
        costMinor: 8400,
        currencyCode: "USD",
        date: "2026-02-01",
        splitType: "equal",
        participants: [
          { userId: bobId, paidMinor: 8400 },
          { userId: carolId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const moved = await apiJson(`/expenses/${created.body.id}`, bobToken, {
      method: "PATCH",
      body: JSON.stringify({
        groupId: flatId,
        description: "Moved 1:1 Electricity",
        costMinor: 8400,
        currencyCode: "USD",
        date: "2026-02-01",
        splitType: "equal",
        participants: [
          { userId: bobId, paidMinor: 8400 },
          { userId: carolId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    assert.ok(
      (await groupListDescriptions(flatId)).includes("Moved 1:1 Electricity"),
      "group list API shows the moved expense to Alice",
    );

    const rows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}`);
    const row = rows.find((r) => r.description === "Moved 1:1 Electricity");
    assert.ok(row, "group CSV export must include a 1:1 expense moved into the group");
    assert.equal(row.group, "Flat");
    assert.equal(row.cost, "84.00");
    assert.equal(row.paid_by, "Bob: 84.00");
    assert.equal(row.owed_by, "Bob: 42.00; Carol: 42.00");
  });

  test("1:1 non-group expense moved into the group via POST /sync/push (EditExpenseDialog path)", async () => {
    const expenseId = ulid();
    const createPush = await apiJson("/sync/push", bobToken, {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "expense.create",
            id: expenseId,
            payload: {
              groupId: null,
              description: "Sync-Moved Water Bill",
              costMinor: 5000,
              currencyCode: "USD",
              date: "2026-02-05",
              splitType: "equal",
              participants: [
                { userId: bobId, paidMinor: 5000 },
                { userId: carolId, paidMinor: 0 },
              ],
            },
          },
        ],
      }),
    });
    assert.equal(createPush.status, 200);
    assert.equal(createPush.body.results[0].status, "applied");

    const movePush = await apiJson("/sync/push", bobToken, {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "expense.update",
            id: expenseId,
            baseVersion: 1,
            payload: {
              groupId: flatId,
              description: "Sync-Moved Water Bill",
              costMinor: 5000,
              currencyCode: "USD",
              date: "2026-02-05",
              splitType: "equal",
              participants: [
                { userId: bobId, paidMinor: 5000 },
                { userId: carolId, paidMinor: 0 },
              ],
            },
          },
        ],
      }),
    });
    assert.equal(movePush.status, 200);
    assert.equal(movePush.body.results[0].status, "applied");

    assert.ok((await groupListDescriptions(flatId)).includes("Sync-Moved Water Bill"));

    const rows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}`);
    const row = rows.find((r) => r.description === "Sync-Moved Water Bill");
    assert.ok(row, "group CSV export must include expenses moved into the group via sync push");
    assert.equal(row.group, "Flat");
  });

  test("expense moved from another group into this group appears in destination CSV only", async () => {
    const created = await apiJson(`/groups/${otherGroupId}/expenses`, bobToken, {
      method: "POST",
      body: JSON.stringify({
        description: "Reassigned Router",
        costMinor: 9000,
        currencyCode: "USD",
        date: "2026-02-10",
        splitType: "equal",
        participants: [
          { userId: bobId, paidMinor: 9000 },
          { userId: carolId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const moved = await apiJson(`/expenses/${created.body.id}`, bobToken, {
      method: "PATCH",
      body: JSON.stringify({
        groupId: flatId,
        description: "Reassigned Router",
        costMinor: 9000,
        currencyCode: "USD",
        date: "2026-02-10",
        splitType: "equal",
        participants: [
          { userId: bobId, paidMinor: 9000 },
          { userId: carolId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    const flatRows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}`);
    const oldRows = await fetchCsvRows(`/expenses.csv?group_id=${otherGroupId}`);

    const flatRow = flatRows.find((r) => r.description === "Reassigned Router");
    assert.ok(flatRow, "destination group CSV must include the moved expense");
    assert.equal(flatRow.group, "Flat");
    assert.equal(
      oldRows.find((r) => r.description === "Reassigned Router"),
      undefined,
      "source group CSV must no longer include the moved expense",
    );
  });

  test("bulk-added group expense for other members via POST /sync/push (BulkAdd path)", async () => {
    // BulkAdd allows creating a group expense where the uploader (Alice) is not
    // the payer or in splitWith, pushing an `expense.create` with splitType "shares".
    const bulkId = ulid();
    const pushed = await apiJson("/sync/push", aliceToken, {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "expense.create",
            id: bulkId,
            payload: {
              groupId: flatId,
              description: "Bulk-Added Cleaning Supplies",
              details: "Imported from receipt CSV",
              costMinor: 3200,
              currencyCode: "USD",
              date: "2026-02-12",
              splitType: "shares",
              participants: [
                { userId: bobId, paidMinor: 3200, input: 1 },
                { userId: carolId, paidMinor: 0, input: 1 },
              ],
            },
          },
        ],
      }),
    });
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.results[0].status, "applied");

    assert.ok((await groupListDescriptions(flatId)).includes("Bulk-Added Cleaning Supplies"));

    const rows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}`);
    const row = rows.find((r) => r.description === "Bulk-Added Cleaning Supplies");
    assert.ok(row, "group CSV export must include bulk-added bills for other group members");
    assert.equal(row.notes, "Imported from receipt CSV");
  });

  test("generic POST /api/v1/expenses with groupId set for other members", async () => {
    const created = await apiJson("/expenses", bobToken, {
      method: "POST",
      body: JSON.stringify({
        groupId: flatId,
        description: "Generic API Groceries",
        costMinor: 4500,
        currencyCode: "JPY",
        date: "2026-02-15",
        splitType: "equal",
        participants: [
          { userId: bobId, paidMinor: 4500 },
          { userId: carolId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    assert.ok((await groupListDescriptions(flatId)).includes("Generic API Groceries"));

    const rows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}`);
    const row = rows.find((r) => r.description === "Generic API Groceries");
    assert.ok(row, "group CSV export must include bills created via generic POST /expenses");
    assert.equal(row.currency, "JPY");
    assert.equal(row.cost, "4500");
  });

  test("settle-up and balance-conversion payments between other members", async () => {
    const settle = await apiJson(`/groups/${flatId}/payments`, aliceToken, {
      method: "POST",
      body: JSON.stringify({
        fromUserId: carolId,
        toUserId: bobId,
        amountMinor: 2500,
        currencyCode: "USD",
        date: "2026-02-18",
      }),
    });
    assert.equal(settle.status, 201, JSON.stringify(settle.body));

    const convertId = ulid();
    const convert = await apiJson("/sync/push", aliceToken, {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "payment.create",
            id: convertId,
            payload: {
              groupId: flatId,
              description: "Converted Balance Transfer",
              costMinor: 1500,
              currencyCode: "EUR",
              date: "2026-02-19",
              splitType: "exact",
              participants: [
                { userId: carolId, paidMinor: 1500, input: 0 },
                { userId: bobId, paidMinor: 0, input: 1500 },
              ],
            },
          },
        ],
      }),
    });
    assert.equal(convert.status, 200);
    assert.equal(convert.body.results[0].status, "applied");

    const rows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}&is_payment=true`);
    const settleRow = rows.find(
      (r) => r.date === "2026-02-18" && r.currency === "USD" && r.cost === "25.00",
    );
    const convertRow = rows.find((r) => r.description === "Converted Balance Transfer");

    assert.ok(settleRow, "group CSV must include settle-up payments between other members");
    assert.equal(settleRow.is_payment, "yes");
    assert.ok(convertRow, "group CSV must include balance-conversion payments between other members");
    assert.equal(convertRow.is_payment, "yes");
  });

  test("guest-link expense and payment added to the group", async () => {
    const guestExpense = await app.request("/api/v1/guest/expenses", {
      method: "POST",
      headers: {
        Authorization: `Bearer link_${ghostSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        groupId: flatId,
        description: "Guest-Added Snacks",
        costMinor: 1800,
        currencyCode: "USD",
        date: "2026-02-20",
        splitType: "equal",
        participants: [
          { userId: ghostId, paidMinor: 1800 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(guestExpense.status, 201, await guestExpense.clone().text());

    const guestPayment = await app.request("/api/v1/guest/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer link_${ghostSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        groupId: flatId,
        fromUserId: bobId,
        toUserId: ghostId,
        amountMinor: 900,
        currencyCode: "USD",
        date: "2026-02-21",
        description: "Guest Settlement",
      }),
    });
    assert.equal(guestPayment.status, 201, await guestPayment.clone().text());

    const rows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}`);
    assert.ok(
      rows.find((r) => r.description === "Guest-Added Snacks"),
      "group CSV must include expenses added via a guest link",
    );
    const paymentRow = rows.find((r) => r.description === "Guest Settlement");
    assert.ok(paymentRow, "group CSV must include payments added via a guest link");
    assert.equal(paymentRow.is_payment, "yes");
  });

  test("recurring template and scheduler-generated occurrence for other members", async () => {
    const template = await apiJson("/expenses", bobToken, {
      method: "POST",
      body: JSON.stringify({
        groupId: flatId,
        description: "Parking Subscription",
        costMinor: 10_000,
        currencyCode: "USD",
        date: "2026-01-10",
        splitType: "equal",
        repeatInterval: "monthly",
        participants: [
          { userId: bobId, paidMinor: 10_000 },
          { userId: carolId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(template.status, 201, JSON.stringify(template.body));

    const run = await runDueRecurrences(new Date("2026-02-15T00:00:00.000Z"));
    assert.equal(run.generated.length, 1);

    const rows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}&q=Parking`);
    const templateRow = rows.find((r) => r.date === "2026-01-10");
    const occurrenceRow = rows.find((r) => r.date === "2026-02-10");

    assert.ok(templateRow, "group CSV must include the recurring template");
    assert.equal(templateRow.repeats, "monthly");
    assert.ok(occurrenceRow, "group CSV must include scheduler-generated occurrences");
    assert.equal(occurrenceRow.repeats, "occurrence");
  });

  test("friend transfer reassigning Alice's group share to another member", async () => {
    // Alice originally participates on this bill, then Bob transfers Alice's
    // shares in Flat to Carol via the friend-transfer route.
    const originalId = await createExpense({
      groupId: flatId,
      description: "Transferred Fiber Internet",
      costMinor: 6000,
      currencyCode: "USD",
      date: "2026-02-24",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 6000 },
        { userId: bobId, paidMinor: 0 },
      ],
      createdBy: aliceId,
    });
    assert.ok(originalId);

    const preview = await apiJson(`/friends/${aliceId}/transfer/preview`, bobToken, {
      method: "POST",
      body: JSON.stringify({
        targetId: carolId,
        mode: "transfer",
        scope: "group",
        groupId: flatId,
      }),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));

    const executed = await apiJson(`/friends/${aliceId}/transfer`, bobToken, {
      method: "POST",
      body: JSON.stringify({
        targetId: carolId,
        mode: "transfer",
        scope: "group",
        groupId: flatId,
        confirmed: true,
        fingerprint: preview.body.fingerprint,
      }),
    });
    assert.equal(executed.status, 200, JSON.stringify(executed.body));

    assert.ok((await groupListDescriptions(flatId)).includes("Transferred Fiber Internet"));

    const rows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}`);
    const row = rows.find((r) => r.description === "Transferred Fiber Internet");
    assert.ok(
      row,
      "group CSV must still include a group expense after Alice's share is transferred to Carol",
    );
    assert.equal(row.paid_by, "Carol: 60.00");
    assert.equal(row.owed_by, "Bob: 30.00; Carol: 30.00");
  });

  test("Splitwise-imported group expense and group import-rounding adjustment", async () => {
    await createExpense({
      groupId: flatId,
      description: "Splitwise Imported Museum Tickets",
      costMinor: 7200,
      currencyCode: "USD",
      date: "2026-02-25",
      splitType: "exact",
      participants: [
        { userId: bobId, paidMinor: 7200, input: 3600 },
        { userId: carolId, paidMinor: 0, input: 3600 },
      ],
      createdBy: aliceId,
      metadata: { splitwise_id: 987654 },
      recordActivity: false,
    });

    await createExpense({
      groupId: flatId,
      description: "Import rounding adjustment",
      costMinor: 2,
      currencyCode: "USD",
      date: "2026-02-25",
      splitType: "exact",
      isPayment: true,
      participants: [
        { userId: bobId, paidMinor: 2, input: 0 },
        { userId: carolId, paidMinor: 0, input: 2 },
      ],
      createdBy: aliceId,
      metadata: { import_rounding: true },
      recordActivity: false,
    });

    const rows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}`);
    assert.ok(
      rows.find((r) => r.description === "Splitwise Imported Museum Tickets"),
      "group CSV must include Splitwise-imported bills between other group members",
    );
    assert.ok(
      rows.find((r) => r.description === "Import rounding adjustment"),
      "group CSV must include group import-rounding adjustments between other members",
    );
  });
});

describe("group CSV export scope and authorization guardrails", () => {
  test("a non-member cannot export a group's expenses", async () => {
    const rows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}`, outsiderToken);
    assert.deepEqual(rows, [], "outsider must never see bills from a group they do not belong to");
  });

  test("a former member who left the group only sees bills they participated in", async () => {
    const rows = await fetchCsvRows(`/expenses.csv?group_id=${flatId}`, formerToken);
    const descriptions = rows.map((r) => r.description);
    assert.ok(
      descriptions.includes("Direct Group Rent"),
      "former member keeps access to bills they personally participated in",
    );
    assert.ok(
      !descriptions.includes("Moved 1:1 Electricity"),
      "former member must not see other members' bills after leaving",
    );
  });

  test("unscoped All-expenses CSV stays participant-only", async () => {
    const rows = await fetchCsvRows("/expenses.csv", aliceToken);
    const descriptions = rows.map((r) => r.description);
    assert.ok(
      descriptions.includes("Alice Personal Lunch"),
      "All-expenses CSV still includes bills Alice participates in",
    );
    assert.ok(
      !descriptions.includes("Moved 1:1 Electricity"),
      "All-expenses CSV must not widen past bills Alice is a participant of",
    );
  });

  test("filters still narrow group CSV exports", async () => {
    const rows = await fetchCsvRows(
      `/expenses.csv?group_id=${flatId}&currency_code=JPY&q=groceries`,
      aliceToken,
    );
    assert.deepEqual(
      rows.map((r) => r.description),
      ["Generic API Groceries"],
    );
  });
});
