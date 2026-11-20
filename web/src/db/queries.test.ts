/**
 * Offline-mirror CSV export tests for group expenses added outside the group
 * screen's direct "+ Expense" flow.
 *
 * `GroupDetail.tsx` renders expenses with `localGroupExpenses(db, groupId, filters)`
 * and triggers CSV downloads via `ExpenseFilters.tsx`, which calls:
 *
 *     localExpenseCsv(db, user.id, { ...csvScope, ...value })
 *
 * with `csvScope = { groupId: group.id }`.
 *
 * These tests run against a lightweight in-memory `LocalDb` double (no browser
 * or IndexedDB needed) and assert that every non-group-native entry visible in
 * `localGroupExpenses` also appears in the exported CSV, while preserving
 * participant-only semantics for "All expenses" and departed groups.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { localExpenseCsv, localGroupExpenses } from "./queries.ts";
import { memberKey, type LocalComment, type LocalDb, type LocalExpense, type LocalGroupMember, type SyncCategory, type SyncCurrency, type SyncGroup, type SyncUser } from "./local.ts";
import { parseBulkCsv, readCsv, validateBulkRow, type BulkContext } from "../bulkAdd.ts";

const ALICE = "01JUSER0000000000000000001";
const BOB = "01JUSER0000000000000000002";
const CAROL = "01JUSER0000000000000000003";
const GHOST = "01JUSER0000000000000000004";

const FLAT = "01JGRP00000000000000000001";
const OTHER_GROUP = "01JGRP00000000000000000002";
const LEFT_GROUP = "01JGRP00000000000000000003";

function user(id: string, name: string, isGhost = false): SyncUser {
  return {
    id,
    name,
    nickname: null,
    iconLetters: null,
    iconEmoji: null,
    iconHue: null,
    iconPattern: null,
    email: isGhost ? null : `${name.toLowerCase()}@example.com`,
    isGhost,
    defaultCurrency: "USD",
    mergedIntoUserId: null,
    deletedAt: null,
  };
}

const USERS: SyncUser[] = [
  user(ALICE, "Alice"),
  user(BOB, "Bob"),
  user(CAROL, "Carol"),
  user(GHOST, "Ghost", true),
];

const USER_BY_ID = new Map(USERS.map((u) => [u.id, u]));

function makeExpense(
  overrides: Partial<LocalExpense> & Pick<LocalExpense, "id" | "description" | "shares">,
): LocalExpense {
  return {
    groupId: FLAT,
    details: null,
    costMinor: 2000,
    currencyCode: "USD",
    date: "2026-03-01T00:00:00.000Z",
    categoryId: 18,
    splitType: "equal",
    splitMeta: null,
    isPayment: false,
    paymentMethod: null,
    repeatInterval: null,
    nextRepeat: null,
    repeatOf: null,
    repeatPaused: null,
    importRounding: false,
    extra: {},
    splitwiseId: null,
    version: 1,
    createdBy: BOB,
    updatedBy: BOB,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    deletedAt: null,
    people: overrides.shares
      .map((s) => USER_BY_ID.get(s.userId))
      .filter((u): u is SyncUser => u !== undefined),
    syncState: "synced",
    conflictWith: null,
    rejectedReason: null,
    ...overrides,
  };
}

function makeTable<T extends Record<string, any>>(rows: T[], keyField: keyof T) {
  return {
    async toArray(): Promise<T[]> {
      return [...rows];
    },
    async get(key: unknown): Promise<T | undefined> {
      return rows.find((r) => r[keyField] === key);
    },
    async bulkGet(keys: unknown[]): Promise<Array<T | undefined>> {
      const byKey = new Map(rows.map((r) => [r[keyField], r]));
      return keys.map((k) => byKey.get(k as T[keyof T]));
    },
    where(field: keyof T) {
      return {
        equals(value: unknown) {
          return {
            async toArray(): Promise<T[]> {
              return rows.filter((r) => r[field] === value);
            },
            async first(): Promise<T | undefined> {
              return rows.find((r) => r[field] === value);
            },
          };
        },
        anyOf(values: unknown[]) {
          const wanted = new Set(values);
          return {
            async toArray(): Promise<T[]> {
              return rows.filter((r) => wanted.has(r[field]));
            },
          };
        },
      };
    },
  };
}

function createFakeLocalDb(expenses: LocalExpense[]): LocalDb {
  const groups: SyncGroup[] = [
    {
      id: FLAT,
      name: "Flat",
      groupType: "home",
      defaultCurrency: "USD",
      simplifyByDefault: true,
      excludedFromTotals: false,
      createdBy: ALICE,
      deletedAt: null,
    },
    {
      id: OTHER_GROUP,
      name: "Old House",
      groupType: "home",
      defaultCurrency: "USD",
      simplifyByDefault: true,
      excludedFromTotals: false,
      createdBy: ALICE,
      deletedAt: null,
    },
    {
      id: LEFT_GROUP,
      name: "Past Trip",
      groupType: "trip",
      defaultCurrency: "USD",
      simplifyByDefault: true,
      excludedFromTotals: false,
      createdBy: BOB,
      deletedAt: null,
    },
  ];

  const groupMembers: LocalGroupMember[] = [
    ...[ALICE, BOB, CAROL, GHOST].map((userId) => ({
      key: memberKey(FLAT, userId),
      groupId: FLAT,
      userId,
      role: userId === ALICE ? "owner" : "member",
      joinedVia: userId === ALICE ? "creator" : "added",
      joinedAt: "2026-01-01T00:00:00.000Z",
      leftAt: null,
      user: USER_BY_ID.get(userId) ?? null,
    })),
    ...[ALICE, BOB, CAROL].map((userId) => ({
      key: memberKey(OTHER_GROUP, userId),
      groupId: OTHER_GROUP,
      userId,
      role: userId === ALICE ? "owner" : "member",
      joinedVia: "added",
      joinedAt: "2026-01-01T00:00:00.000Z",
      leftAt: null,
      user: USER_BY_ID.get(userId) ?? null,
    })),
    {
      key: memberKey(LEFT_GROUP, ALICE),
      groupId: LEFT_GROUP,
      userId: ALICE,
      role: "member",
      joinedVia: "added",
      joinedAt: "2026-01-01T00:00:00.000Z",
      leftAt: "2026-02-01T00:00:00.000Z",
      user: USER_BY_ID.get(ALICE) ?? null,
    },
    {
      key: memberKey(LEFT_GROUP, BOB),
      groupId: LEFT_GROUP,
      userId: BOB,
      role: "owner",
      joinedVia: "creator",
      joinedAt: "2026-01-01T00:00:00.000Z",
      leftAt: null,
      user: USER_BY_ID.get(BOB) ?? null,
    },
  ];

  const currencies: SyncCurrency[] = [
    { code: "USD", decimalPlaces: 2, symbol: "$", name: "US Dollar" },
    { code: "JPY", decimalPlaces: 0, symbol: "¥", name: "Japanese Yen" },
    { code: "EUR", decimalPlaces: 2, symbol: "€", name: "Euro" },
  ];

  const categories: SyncCategory[] = [
    { id: 18, parentId: null, name: "General", icon: null, isDefault: true },
    { id: 13, parentId: 12, name: "Dining out", icon: null, isDefault: false },
  ];

  const comments: LocalComment[] = [];

  return {
    expenses: makeTable(expenses, "id"),
    groups: makeTable(groups, "id"),
    groupMembers: makeTable(groupMembers, "key"),
    users: makeTable(USERS, "id"),
    currencies: makeTable(currencies, "code"),
    categories: makeTable(categories, "id"),
    comments: makeTable(comments, "id"),
  } as unknown as LocalDb;
}

function parseCsvObjects(csv: string): Array<Record<string, string>> {
  const [header, ...data] = readCsv(csv);
  if (!header) return [];
  return data.map((cells) =>
    Object.fromEntries(header.map((col, i) => [col, cells[i] ?? ""])),
  );
}

describe("localExpenseCsv for group scope matches localGroupExpenses", () => {
  test("includes a 1:1 non-group expense moved into the group by another member", async () => {
    const moved = makeExpense({
      id: "01JEXP00000000000000000001",
      groupId: FLAT,
      description: "Moved 1:1 Electricity",
      costMinor: 8400,
      version: 2,
      shares: [
        { userId: BOB, paidShareMinor: 8400, owedShareMinor: 4200, splitInput: null },
        { userId: CAROL, paidShareMinor: 0, owedShareMinor: 4200, splitInput: null },
      ],
    });
    const db = createFakeLocalDb([moved]);

    const list = await localGroupExpenses(db, FLAT);
    assert.deepEqual(
      list.expenses.map((e) => e.description),
      ["Moved 1:1 Electricity"],
    );

    const rows = parseCsvObjects(await localExpenseCsv(db, ALICE, { groupId: FLAT }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.description, "Moved 1:1 Electricity");
    assert.equal(rows[0]!.group, "Flat");
    assert.equal(rows[0]!.paid_by, "Bob: 84.00");
    assert.equal(rows[0]!.owed_by, "Bob: 42.00; Carol: 42.00");
  });

  test("includes an expense moved from another group and omits it from the old group CSV", async () => {
    const moved = makeExpense({
      id: "01JEXP00000000000000000002",
      groupId: FLAT,
      description: "Moved From Old House",
      costMinor: 9000,
      version: 2,
      shares: [
        { userId: BOB, paidShareMinor: 9000, owedShareMinor: 4500, splitInput: null },
        { userId: CAROL, paidShareMinor: 0, owedShareMinor: 4500, splitInput: null },
      ],
    });
    const db = createFakeLocalDb([moved]);

    const flatRows = parseCsvObjects(await localExpenseCsv(db, ALICE, { groupId: FLAT }));
    const oldRows = parseCsvObjects(await localExpenseCsv(db, ALICE, { groupId: OTHER_GROUP }));

    assert.deepEqual(
      flatRows.map((r) => r.description),
      ["Moved From Old House"],
    );
    assert.deepEqual(oldRows, []);
  });

  test("includes a pending BulkAdd group expense created for other members", async () => {
    // Run through the real BulkAdd CSV parser + validator to produce the exact
    // payload BulkAdd enqueues into Dexie as a pending expense.
    const bulkContext: BulkContext = {
      selfId: ALICE,
      people: USERS.map((u) => ({ id: u.id, name: u.name, nickname: u.nickname, email: u.email })),
      groups: [
        { id: FLAT, name: "Flat", memberIds: [ALICE, BOB, CAROL, GHOST], defaultCurrency: "USD" },
      ],
      categories: [{ id: 18, name: "General", path: "General" }],
      currencies: [{ code: "USD", decimal_places: 2 }],
    };

    const parsed = parseBulkCsv(
      "date,description,amount,currency,paid_by,split_with,group,category,notes\n" +
        "2026-03-04,Bulk-Added Supplies,32.00,USD,Bob,Bob;Carol,Flat,,Receipt CSV",
      bulkContext,
      { currency: "USD", group: FLAT, payer: ALICE, splitWith: [ALICE, BOB] },
    );
    const validated = validateBulkRow(parsed[0]!, bulkContext);
    assert.deepEqual(validated.errors, []);
    assert.ok(validated.input);

    const pendingBulk = makeExpense({
      id: "01JEXP00000000000000000003",
      groupId: validated.input.groupId ?? null,
      description: validated.input.description,
      details: validated.input.details ?? null,
      costMinor: validated.input.costMinor,
      currencyCode: validated.input.currencyCode,
      date: `${validated.input.date}T00:00:00.000Z`,
      splitType: validated.input.splitType,
      createdBy: ALICE,
      updatedBy: ALICE,
      syncState: "pending",
      shares: [
        { userId: BOB, paidShareMinor: 3200, owedShareMinor: 1600, splitInput: 1 },
        { userId: CAROL, paidShareMinor: 0, owedShareMinor: 1600, splitInput: 1 },
      ],
    });
    const db = createFakeLocalDb([pendingBulk]);

    const rows = parseCsvObjects(await localExpenseCsv(db, ALICE, { groupId: FLAT }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.description, "Bulk-Added Supplies");
    assert.equal(rows[0]!.notes, "Receipt CSV");
  });

  test("includes settle-up and balance-conversion payments between other members", async () => {
    const payment = makeExpense({
      id: "01JEXP00000000000000000004",
      groupId: FLAT,
      description: "Payment",
      costMinor: 2500,
      currencyCode: "EUR",
      isPayment: true,
      splitType: "exact",
      createdBy: ALICE,
      shares: [
        { userId: CAROL, paidShareMinor: 2500, owedShareMinor: 0, splitInput: 0 },
        { userId: BOB, paidShareMinor: 0, owedShareMinor: 2500, splitInput: 2500 },
      ],
    });
    const db = createFakeLocalDb([payment]);

    const rows = parseCsvObjects(await localExpenseCsv(db, ALICE, { groupId: FLAT }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.is_payment, "yes");
    assert.equal(rows[0]!.currency, "EUR");
    assert.equal(rows[0]!.cost, "25.00");
  });

  test("includes guest-created, scheduler-generated, friend-transferred, and Splitwise-imported rows", async () => {
    const guestBill = makeExpense({
      id: "01JEXP00000000000000000005",
      description: "Guest-Added Snacks",
      costMinor: 1800,
      date: "2026-03-05T00:00:00.000Z",
      createdBy: GHOST,
      shares: [
        { userId: GHOST, paidShareMinor: 1800, owedShareMinor: 900, splitInput: null },
        { userId: BOB, paidShareMinor: 0, owedShareMinor: 900, splitInput: null },
      ],
    });

    const recurringOccurrence = makeExpense({
      id: "01JEXP00000000000000000006",
      description: "Parking Subscription",
      costMinor: 10_000,
      date: "2026-03-06T00:00:00.000Z",
      repeatOf: "01JTEMPLATE000000000000001",
      shares: [
        { userId: BOB, paidShareMinor: 10_000, owedShareMinor: 5000, splitInput: null },
        { userId: CAROL, paidShareMinor: 0, owedShareMinor: 5000, splitInput: null },
      ],
    });

    const transferred = makeExpense({
      id: "01JEXP00000000000000000007",
      description: "Transferred Fiber Internet",
      costMinor: 6000,
      date: "2026-03-07T00:00:00.000Z",
      createdBy: ALICE,
      version: 2,
      shares: [
        { userId: CAROL, paidShareMinor: 6000, owedShareMinor: 3000, splitInput: null },
        { userId: BOB, paidShareMinor: 0, owedShareMinor: 3000, splitInput: null },
      ],
    });

    const splitwiseImported = makeExpense({
      id: "01JEXP00000000000000000008",
      description: "Splitwise Imported Museum",
      costMinor: 3400,
      currencyCode: "JPY",
      date: "2026-03-08T00:00:00.000Z",
      splitType: "exact",
      splitwiseId: 987654,
      shares: [
        { userId: BOB, paidShareMinor: 3400, owedShareMinor: 1700, splitInput: 1700 },
        { userId: CAROL, paidShareMinor: 0, owedShareMinor: 1700, splitInput: 1700 },
      ],
    });

    const importRounding = makeExpense({
      id: "01JEXP00000000000000000009",
      description: "Import rounding adjustment",
      costMinor: 2,
      currencyCode: "JPY",
      date: "2026-03-08T00:00:00.000Z",
      isPayment: true,
      splitType: "exact",
      importRounding: true,
      shares: [
        { userId: BOB, paidShareMinor: 2, owedShareMinor: 0, splitInput: 0 },
        { userId: CAROL, paidShareMinor: 0, owedShareMinor: 2, splitInput: 2 },
      ],
    });

    const db = createFakeLocalDb([
      guestBill,
      recurringOccurrence,
      transferred,
      splitwiseImported,
      importRounding,
    ]);

    const listDescriptions = (await localGroupExpenses(db, FLAT)).expenses.map((e) => e.description);
    const csvDescriptions = parseCsvObjects(
      await localExpenseCsv(db, ALICE, { groupId: FLAT }),
    ).map((r) => r.description);

    assert.deepEqual(
      csvDescriptions,
      listDescriptions,
      "group CSV export must match every non-group-native row shown in localGroupExpenses",
    );
  });

  test("preserves filters, excludes deleted/other-group rows, and keeps All-expenses & departed groups participant-only", async () => {
    const bobCarolInFlat = makeExpense({
      id: "01JEXP00000000000000000010",
      groupId: FLAT,
      description: "Bob and Carol Dinner",
      currencyCode: "JPY",
      costMinor: 4000,
      shares: [
        { userId: BOB, paidShareMinor: 4000, owedShareMinor: 2000, splitInput: null },
        { userId: CAROL, paidShareMinor: 0, owedShareMinor: 2000, splitInput: null },
      ],
    });
    const deletedInFlat = makeExpense({
      id: "01JEXP00000000000000000011",
      groupId: FLAT,
      description: "Deleted Group Bill",
      deletedAt: "2026-03-02T00:00:00.000Z",
      shares: [
        { userId: BOB, paidShareMinor: 2000, owedShareMinor: 1000, splitInput: null },
        { userId: CAROL, paidShareMinor: 0, owedShareMinor: 1000, splitInput: null },
      ],
    });
    const inOtherGroup = makeExpense({
      id: "01JEXP00000000000000000012",
      groupId: OTHER_GROUP,
      description: "Other Group Bill",
      shares: [
        { userId: BOB, paidShareMinor: 2000, owedShareMinor: 1000, splitInput: null },
        { userId: CAROL, paidShareMinor: 0, owedShareMinor: 1000, splitInput: null },
      ],
    });
    const aliceInLeftGroup = makeExpense({
      id: "01JEXP00000000000000000013",
      groupId: LEFT_GROUP,
      description: "Alice Past Trip Bill",
      shares: [
        { userId: ALICE, paidShareMinor: 2000, owedShareMinor: 1000, splitInput: null },
        { userId: BOB, paidShareMinor: 0, owedShareMinor: 1000, splitInput: null },
      ],
    });
    const othersInLeftGroup = makeExpense({
      id: "01JEXP00000000000000000014",
      groupId: LEFT_GROUP,
      description: "Others Past Trip Bill",
      shares: [
        { userId: BOB, paidShareMinor: 2000, owedShareMinor: 1000, splitInput: null },
        { userId: CAROL, paidShareMinor: 0, owedShareMinor: 1000, splitInput: null },
      ],
    });

    const db = createFakeLocalDb([
      bobCarolInFlat,
      deletedInFlat,
      inOtherGroup,
      aliceInLeftGroup,
      othersInLeftGroup,
    ]);

    const filteredFlat = parseCsvObjects(
      await localExpenseCsv(db, ALICE, { groupId: FLAT, currencyCode: "JPY", q: "dinner" }),
    );
    assert.deepEqual(
      filteredFlat.map((r) => r.description),
      ["Bob and Carol Dinner"],
    );

    const allExpenses = parseCsvObjects(await localExpenseCsv(db, ALICE));
    assert.deepEqual(
      allExpenses.map((r) => r.description),
      ["Alice Past Trip Bill"],
      "unscoped All-expenses CSV stays participant-only",
    );

    const leftGroupRows = parseCsvObjects(
      await localExpenseCsv(db, ALICE, { groupId: LEFT_GROUP }),
    );
    assert.deepEqual(
      leftGroupRows.map((r) => r.description),
      ["Alice Past Trip Bill"],
      "a group the user has left only exports bills they personally participated in",
    );
  });
});
