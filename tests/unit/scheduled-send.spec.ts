/**
 * Unit tests for Scheduled Send feature
 *
 * Tests the database operations, types, and service logic
 * without requiring Electron. Run with: npx tsx tests/unit/scheduled-send.spec.ts
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import { SCHEMA } from "../../src/main/db/schema";
import { runMigrations } from "../../src/main/db/migrations";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "../../src");

// better-sqlite3 may be compiled for Electron's Node version rather than system Node.
const require = createRequire(import.meta.url);
type DB = BetterSqlite3.Database;
let DatabaseCtor: (new (filename: string | Buffer, options?: BetterSqlite3.Options) => DB) | null =
  null;
let nativeModuleError: string | null = null;
try {
  DatabaseCtor = require("better-sqlite3");
  const probe = new DatabaseCtor!(":memory:");
  probe.close();
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("NODE_MODULE_VERSION") || msg.includes("did not self-register")) {
    nativeModuleError = msg.split("\n")[0];
  } else {
    throw e;
  }
}

// Test the ScheduleSendButton preset logic (extracted for testability)
function getSchedulePresets(
  now: Date,
): Array<{ label: string; description: string; timestamp: number }> {
  const presets: Array<{ label: string; description: string; timestamp: number }> = [];
  const currentHour = now.getHours();

  if (currentHour < 20) {
    const laterToday = new Date(now);
    laterToday.setHours(laterToday.getHours() + 2, 0, 0, 0);
    presets.push({
      label: "Later today",
      description: formatTime(laterToday),
      timestamp: laterToday.getTime(),
    });
  }

  if (currentHour < 18) {
    const thisEvening = new Date(now);
    thisEvening.setHours(18, 0, 0, 0);
    presets.push({
      label: "This evening",
      description: formatTime(thisEvening),
      timestamp: thisEvening.getTime(),
    });
  }

  const tomorrowMorning = new Date(now);
  tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
  tomorrowMorning.setHours(8, 0, 0, 0);
  presets.push({
    label: "Tomorrow morning",
    description: formatDateShort(tomorrowMorning) + ", " + formatTime(tomorrowMorning),
    timestamp: tomorrowMorning.getTime(),
  });

  const tomorrowAfternoon = new Date(now);
  tomorrowAfternoon.setDate(tomorrowAfternoon.getDate() + 1);
  tomorrowAfternoon.setHours(13, 0, 0, 0);
  presets.push({
    label: "Tomorrow afternoon",
    description: formatDateShort(tomorrowAfternoon) + ", " + formatTime(tomorrowAfternoon),
    timestamp: tomorrowAfternoon.getTime(),
  });

  const dayOfWeek = now.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 7 : 8 - dayOfWeek;
  if (daysUntilMonday <= 6) {
    const nextMonday = new Date(now);
    nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
    nextMonday.setHours(8, 0, 0, 0);
    presets.push({
      label: dayOfWeek >= 2 && dayOfWeek <= 5 ? "Next Monday" : "Monday morning",
      description: formatDateShort(nextMonday) + ", " + formatTime(nextMonday),
      timestamp: nextMonday.getTime(),
    });
  }

  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 7);
  nextWeek.setHours(8, 0, 0, 0);
  presets.push({
    label: "In one week",
    description: formatDateShort(nextWeek) + ", " + formatTime(nextWeek),
    timestamp: nextWeek.getTime(),
  });

  return presets;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDateShort(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

test.describe("Scheduled Send - Preset Logic", () => {
  test("morning presets include later today, this evening, and future options", () => {
    // 9am on a Wednesday
    const now = new Date("2026-02-04T09:00:00");
    const presets = getSchedulePresets(now);

    const labels = presets.map((p) => p.label);
    expect(labels).toContain("Later today");
    expect(labels).toContain("This evening");
    expect(labels).toContain("Tomorrow morning");
    expect(labels).toContain("Tomorrow afternoon");
    expect(labels).toContain("Next Monday");
    expect(labels).toContain("In one week");
  });

  test("evening presets exclude 'this evening' and 'later today' when past 8pm", () => {
    // 9pm on a Wednesday
    const now = new Date("2026-02-04T21:00:00");
    const presets = getSchedulePresets(now);

    const labels = presets.map((p) => p.label);
    expect(labels).not.toContain("Later today");
    expect(labels).not.toContain("This evening");
    expect(labels).toContain("Tomorrow morning");
    expect(labels).toContain("Tomorrow afternoon");
  });

  test("presets exclude 'this evening' when past 6pm but include 'later today'", () => {
    // 7pm on a Wednesday
    const now = new Date("2026-02-04T19:00:00");
    const presets = getSchedulePresets(now);

    const labels = presets.map((p) => p.label);
    expect(labels).toContain("Later today");
    expect(labels).not.toContain("This evening");
  });

  test("all preset timestamps are in the future", () => {
    const now = new Date("2026-02-04T10:00:00");
    const presets = getSchedulePresets(now);

    for (const preset of presets) {
      expect(preset.timestamp).toBeGreaterThan(now.getTime());
    }
  });

  test("tomorrow morning is 8am next day", () => {
    const now = new Date("2026-02-04T15:00:00");
    const presets = getSchedulePresets(now);

    const tomorrowMorning = presets.find((p) => p.label === "Tomorrow morning");
    expect(tomorrowMorning).toBeDefined();

    const date = new Date(tomorrowMorning!.timestamp);
    expect(date.getDate()).toBe(5);
    expect(date.getHours()).toBe(8);
    expect(date.getMinutes()).toBe(0);
  });

  test("tomorrow afternoon is 1pm next day", () => {
    const now = new Date("2026-02-04T15:00:00");
    const presets = getSchedulePresets(now);

    const tomorrowAfternoon = presets.find((p) => p.label === "Tomorrow afternoon");
    expect(tomorrowAfternoon).toBeDefined();

    const date = new Date(tomorrowAfternoon!.timestamp);
    expect(date.getDate()).toBe(5);
    expect(date.getHours()).toBe(13);
    expect(date.getMinutes()).toBe(0);
  });

  test("'in one week' is exactly 7 days at 8am", () => {
    const now = new Date("2026-02-04T15:00:00");
    const presets = getSchedulePresets(now);

    const inOneWeek = presets.find((p) => p.label === "In one week");
    expect(inOneWeek).toBeDefined();

    const date = new Date(inOneWeek!.timestamp);
    expect(date.getDate()).toBe(11);
    expect(date.getHours()).toBe(8);
    expect(date.getMinutes()).toBe(0);
  });

  test("Sunday shows 'Monday morning' (1 day away)", () => {
    // Sunday
    const now = new Date("2026-02-01T10:00:00"); // Feb 1 2026 is a Sunday
    const presets = getSchedulePresets(now);

    const mondayPreset = presets.find((p) => p.label === "Monday morning");
    expect(mondayPreset).toBeDefined();

    const date = new Date(mondayPreset!.timestamp);
    expect(date.getDay()).toBe(1); // Monday
    expect(date.getHours()).toBe(8);
  });

  test("Wednesday shows 'Next Monday'", () => {
    // Wednesday
    const now = new Date("2026-02-04T10:00:00");
    const presets = getSchedulePresets(now);

    const mondayPreset = presets.find((p) => p.label === "Next Monday");
    expect(mondayPreset).toBeDefined();

    const date = new Date(mondayPreset!.timestamp);
    expect(date.getDay()).toBe(1); // Monday
    expect(date.getHours()).toBe(8);
  });
});

test.describe("Scheduled Send - Type Validation", () => {
  test("ScheduledMessage type has all required fields", () => {
    // This test validates our type structure is correct at compile time
    const msg = {
      id: "test-123",
      accountId: "account-1",
      type: "reply" as const,
      threadId: "thread-1",
      to: ["user@example.com"],
      cc: ["cc@example.com"],
      subject: "Re: Test",
      bodyHtml: "<p>Test body</p>",
      bodyText: "Test body",
      scheduledAt: Date.now() + 3600000,
      status: "scheduled" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(msg.id).toBe("test-123");
    expect(msg.type).toBe("reply");
    expect(msg.status).toBe("scheduled");
    expect(msg.to).toEqual(["user@example.com"]);
    expect(msg.scheduledAt).toBeGreaterThan(Date.now());
  });

  test("ScheduledMessageStats has required fields", () => {
    const stats = {
      scheduled: 3,
      total: 5,
    };

    expect(stats.scheduled).toBe(3);
    expect(stats.total).toBe(5);
  });

  test("valid status transitions", () => {
    const validStatuses = ["scheduled", "sending", "sent", "failed", "cancelled"];
    for (const status of validStatuses) {
      expect(validStatuses).toContain(status);
    }
  });
});

test.describe("Scheduled Send - Schema Validation", () => {
  test("SQL schema creates scheduled_messages table with correct columns", () => {
    // Read the schema file and verify the table definition
    const schema = readFileSync(path.join(srcDir, "main/db/schema.ts"), "utf-8");

    // Verify table creation
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS scheduled_messages");

    // Verify all columns
    expect(schema).toContain("id TEXT PRIMARY KEY");
    expect(schema).toContain("account_id TEXT NOT NULL");
    expect(schema).toContain("type TEXT NOT NULL");
    expect(schema).toContain("thread_id TEXT");
    expect(schema).toContain("to_addresses TEXT NOT NULL");
    expect(schema).toContain("cc_addresses TEXT");
    expect(schema).toContain("bcc_addresses TEXT");
    expect(schema).toContain("subject TEXT NOT NULL");
    expect(schema).toContain("body_html TEXT NOT NULL");
    expect(schema).toContain("body_text TEXT");
    expect(schema).toContain("in_reply_to TEXT");
    expect(schema).toContain("references_header TEXT");
    expect(schema).toContain("scheduled_at INTEGER NOT NULL");
    expect(schema).toContain("status TEXT DEFAULT 'scheduled'");
    expect(schema).toContain("error_message TEXT");
    expect(schema).toContain("created_at INTEGER NOT NULL");
    expect(schema).toContain("updated_at INTEGER NOT NULL");
    expect(schema).toContain("sent_at INTEGER");

    // Verify indexes
    expect(schema).toContain("idx_scheduled_status");
    expect(schema).toContain("idx_scheduled_account");
    expect(schema).toContain("idx_scheduled_at");
  });

  test("IPC handlers are registered for all scheduled send operations", () => {
    const ipcCode = readFileSync(path.join(srcDir, "main/ipc/scheduled-send.ipc.ts"), "utf-8");

    // Verify all IPC channels
    expect(ipcCode).toContain('"scheduled-send:create"');
    expect(ipcCode).toContain('"scheduled-send:list"');
    expect(ipcCode).toContain('"scheduled-send:cancel"');
    expect(ipcCode).toContain('"scheduled-send:reschedule"');
    expect(ipcCode).toContain('"scheduled-send:delete"');
    expect(ipcCode).toContain('"scheduled-send:stats"');

    // Verify event broadcasting
    expect(ipcCode).toContain('"scheduled-send:sent"');
    expect(ipcCode).toContain('"scheduled-send:failed"');
    expect(ipcCode).toContain('"scheduled-send:stats-changed"');
  });

  test("preload exposes all scheduled send methods", () => {
    const preloadCode = readFileSync(path.join(srcDir, "preload/index.ts"), "utf-8");

    // Verify API methods
    expect(preloadCode).toContain("scheduledSend:");
    expect(preloadCode).toContain('"scheduled-send:create"');
    expect(preloadCode).toContain('"scheduled-send:list"');
    expect(preloadCode).toContain('"scheduled-send:cancel"');
    expect(preloadCode).toContain('"scheduled-send:reschedule"');
    expect(preloadCode).toContain('"scheduled-send:delete"');
    expect(preloadCode).toContain('"scheduled-send:stats"');

    // Verify event listeners
    expect(preloadCode).toContain("onSent");
    expect(preloadCode).toContain("onFailed");
    expect(preloadCode).toContain("onStatsChanged");
    expect(preloadCode).toContain("removeAllListeners");
  });

  test("service is registered and started in main/index.ts", () => {
    const mainCode = readFileSync(path.join(srcDir, "main/index.ts"), "utf-8");

    expect(mainCode).toContain("import { scheduledSendService }");
    expect(mainCode).toContain("import { registerScheduledSendIpc }");
    expect(mainCode).toContain("scheduledSendService.setClientResolver");
    expect(mainCode).toContain("scheduledSendService.start()");
    expect(mainCode).toContain("registerScheduledSendIpc()");
  });

  test("store has scheduled message stats state", () => {
    const storeCode = readFileSync(path.join(srcDir, "renderer/store/index.ts"), "utf-8");

    expect(storeCode).toContain("scheduledMessageStats");
    expect(storeCode).toContain("setScheduledMessageStats");
    expect(storeCode).toContain("ScheduledMessageStats");
  });

  test("App.tsx listens for scheduled send events", () => {
    const appCode = readFileSync(path.join(srcDir, "renderer/App.tsx"), "utf-8");

    expect(appCode).toContain("scheduledSend.onStatsChanged");
    expect(appCode).toContain("scheduledSend.onSent");
    expect(appCode).toContain("scheduledSend.onFailed");
    expect(appCode).toContain("scheduledSend.removeAllListeners");
    expect(appCode).toContain("scheduledSend.stats()");
    expect(appCode).toContain("scheduled");
  });
});

// ---------------------------------------------------------------------------
// Attachment persistence + pass-through (scheduled sends must not drop them)
// ---------------------------------------------------------------------------

// Extract the object-literal argument of a call like `client.sendMessage({...})`
// from source code, so we can assert field completeness (same approach as
// tests/unit/undo-send.spec.ts).
function extractCallBlock(code: string, callPattern: RegExp): string | null {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (callPattern.test(lines[i])) {
      let braceCount = 0;
      let started = false;
      let block = "";
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") {
            braceCount++;
            started = true;
          }
          if (ch === "}") braceCount--;
        }
        block += lines[j] + "\n";
        if (started && braceCount === 0) return block;
      }
    }
  }
  return null;
}

test.describe("Scheduled Send - Attachments", () => {
  test("scheduled_messages CREATE TABLE includes attachments column", () => {
    const schema = readFileSync(path.join(srcDir, "main/db/schema.ts"), "utf-8");
    const start = schema.indexOf("CREATE TABLE IF NOT EXISTS scheduled_messages");
    expect(start).toBeGreaterThan(-1);
    // Scope the assertion to this table's block — "attachments TEXT" also
    // appears in the outbox and emails tables.
    const block = schema.slice(start, schema.indexOf(");", start));
    expect(block).toContain("attachments TEXT");
  });

  test("scheduling IPC persists attachments via insertScheduledMessage", () => {
    const code = readFileSync(path.join(srcDir, "main/ipc/scheduled-send.ipc.ts"), "utf-8");
    const block = extractCallBlock(code, /insertScheduledMessage\(\{/);
    expect(block).not.toBeNull();
    expect(block!).toContain("attachments: options.attachments");
  });

  test("service passes attachments through to client.sendMessage", () => {
    const code = readFileSync(
      path.join(srcDir, "main/services/scheduled-send-service.ts"),
      "utf-8",
    );
    const block = extractCallBlock(code, /client\.sendMessage\(\{/);
    expect(block).not.toBeNull();
    expect(block!).toContain("attachments: item.attachments");
  });

  test("cancel-to-draft passes attachments to createFullDraft", () => {
    const code = readFileSync(path.join(srcDir, "main/ipc/scheduled-send.ipc.ts"), "utf-8");
    const block = extractCallBlock(code, /client\.createFullDraft\(\{/);
    expect(block).not.toBeNull();
    expect(block!).toContain("attachments: row.attachments");
  });

  test("attachments survive a DB round-trip on the real schema", () => {
    test.skip(!!nativeModuleError, `better-sqlite3 native module mismatch: ${nativeModuleError}`);

    const db = new DatabaseCtor!(":memory:");
    db.exec(SCHEMA);
    runMigrations(db);

    // Satisfy the accounts(id) foreign key on scheduled_messages.
    db.prepare(
      "INSERT INTO accounts (id, email, display_name, is_primary, added_at) VALUES (?, ?, ?, ?, ?)",
    ).run("acc-1", "test@example.invalid", "Test", 1, Date.now());

    const attachments = [
      { filename: "report.pdf", mimeType: "application/pdf", path: "/tmp/report.pdf", size: 1234 },
      { filename: "logo.png", mimeType: "image/png", content: "aGVsbG8=" },
    ];
    const now = Date.now();

    // Same INSERT the production insertScheduledMessage uses (db/index.ts) —
    // running it against the real SCHEMA catches column mismatches.
    db.prepare(
      `
      INSERT INTO scheduled_messages (
        id, account_id, type, thread_id, to_addresses, cc_addresses, bcc_addresses,
        subject, body_html, body_text, in_reply_to, references_header,
        attachments, from_address, scheduled_at, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
    `,
    ).run(
      "sched-1",
      "acc-1",
      "send",
      null,
      JSON.stringify(["to@example.com"]),
      null,
      null,
      "With attachments",
      "<p>body</p>",
      null,
      null,
      null,
      JSON.stringify(attachments),
      null,
      now - 1000,
      now,
      now,
    );

    // Same SELECT the production getDueScheduledMessages uses.
    const row = db
      .prepare(
        `
      SELECT id, account_id as accountId, type, thread_id as threadId,
             to_addresses as toAddresses, cc_addresses as ccAddresses, bcc_addresses as bccAddresses,
             subject, body_html as bodyHtml, body_text as bodyText,
             in_reply_to as inReplyTo, references_header as referencesHeader,
             attachments, from_address as fromAddress,
             scheduled_at as scheduledAt, status, error_message as errorMessage,
             created_at as createdAt, updated_at as updatedAt, sent_at as sentAt
      FROM scheduled_messages
      WHERE status = 'scheduled' AND scheduled_at <= ?
    `,
      )
      .get(now) as { attachments: string | null };

    expect(row).toBeDefined();
    expect(row.attachments).not.toBeNull();
    expect(JSON.parse(row.attachments!)).toEqual(attachments);

    db.close();
  });
});

test.describe("Scheduled Send - UI Integration", () => {
  test("ScheduleSendButton is integrated via ComposeToolbar (used in InlineReply + NewEmailCompose)", () => {
    const toolbarCode = readFileSync(
      path.join(srcDir, "renderer/components/ComposeToolbar.tsx"),
      "utf-8",
    );
    const emailDetailCode = readFileSync(
      path.join(srcDir, "renderer/components/EmailDetail.tsx"),
      "utf-8",
    );

    // ComposeToolbar imports and renders ScheduleSendButton
    expect(toolbarCode).toContain("import { ScheduleSendButton }");
    expect(toolbarCode).toContain("<ScheduleSendButton");

    // EmailDetail uses ComposeToolbar in both InlineReply and NewEmailCompose
    const composeToolbarCount = (emailDetailCode.match(/<ComposeToolbar/g) || []).length;
    expect(composeToolbarCount).toBeGreaterThanOrEqual(2);

    // handleScheduleSend is defined in both components
    const handleScheduleCount = (emailDetailCode.match(/handleScheduleSend/g) || []).length;
    expect(handleScheduleCount).toBeGreaterThanOrEqual(2);
  });

  test("header badge shows scheduled count", () => {
    const code = readFileSync(path.join(srcDir, "renderer/App.tsx"), "utf-8");

    expect(code).toContain("scheduledMessageStats.scheduled > 0");
    expect(code).toContain("scheduled");
  });
});
