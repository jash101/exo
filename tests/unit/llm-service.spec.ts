/**
 * Unit tests for AnthropicService — the centralized Claude API wrapper.
 *
 * Tests cover: happy path, retry logic, cost recording, timeout,
 * error recording, and query functions (getUsageStats, getCallHistory).
 *
 * Strategy: Use _setClientForTesting() to inject a mock client, and
 * setAnthropicServiceDb() with an in-memory SQLite database for cost tracking.
 */
import { test, expect } from "@playwright/test";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import {
  createMessage,
  _setClientForTesting,
  setAnthropicServiceDb,
  setDeepSeekConfig,
  getUsageStats,
  getCallHistory,
  type LlmCallRecord,
} from "../../src/main/services/llm-service";

const require = createRequire(import.meta.url);

// --- Database setup ---

type DB = BetterSqlite3.Database;
let DatabaseCtor: (new (filename: string | Buffer, options?: BetterSqlite3.Options) => DB) | null =
  null;
let nativeModuleError: string | null = null;
try {
  DatabaseCtor = require("better-sqlite3");
  const testDb = new DatabaseCtor!(":memory:");
  testDb.close();
} catch (e: unknown) {
  const err = e as Error;
  if (
    err.message?.includes("NODE_MODULE_VERSION") ||
    err.message?.includes("did not self-register")
  ) {
    nativeModuleError = err.message.split("\n")[0];
  } else {
    throw e;
  }
}

// --- Mock Anthropic client ---

interface MockCall {
  params: Record<string, unknown>;
  options?: Record<string, unknown>;
}

function createMockClient(
  behavior: "success" | "rate-limit-then-success" | "server-error-then-success" | "always-fail",
  failCount: number = 1,
) {
  const calls: MockCall[] = [];
  let callIndex = 0;

  const client = {
    messages: {
      create: async (params: Record<string, unknown>, options?: Record<string, unknown>) => {
        calls.push({ params, options });
        callIndex++;

        if (behavior === "success") {
          return makeSuccessResponse(params.model as string);
        }

        if (behavior === "rate-limit-then-success") {
          if (callIndex <= failCount) {
            throw new Anthropic.RateLimitError(
              429,
              { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
              "Rate limited",
              new Headers(),
            );
          }
          return makeSuccessResponse(params.model as string);
        }

        if (behavior === "server-error-then-success") {
          if (callIndex <= failCount) {
            throw new Anthropic.InternalServerError(
              500,
              { type: "error", error: { type: "server_error", message: "Server error" } },
              "Server error",
              new Headers(),
            );
          }
          return makeSuccessResponse(params.model as string);
        }

        if (behavior === "always-fail") {
          throw new Anthropic.BadRequestError(
            400,
            { type: "error", error: { type: "invalid_request_error", message: "Bad request" } },
            "Bad request",
            new Headers(),
          );
        }

        throw new Error("Unknown behavior");
      },
    },
  };

  return { client, calls };
}

function makeSuccessResponse(model: string = "claude-sonnet-4-20250514") {
  return {
    id: "msg_test_123",
    type: "message" as const,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Hello, world!" }],
    model,
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 10,
    },
  };
}

function makeTestParams(model: string = "claude-sonnet-4-20250514") {
  return {
    model,
    max_tokens: 256,
    messages: [{ role: "user" as const, content: "Hello" }],
  };
}

// --- Tests ---

test.describe("AnthropicService", () => {
  // Skip all tests if native module is unavailable
  test.skip(!!nativeModuleError, `Skipping: ${nativeModuleError}`);

  let testDb: DB;

  test.beforeEach(() => {
    // Fresh in-memory DB for each test
    testDb = new DatabaseCtor!(":memory:");
    setAnthropicServiceDb(testDb);
  });

  test.afterEach(() => {
    _setClientForTesting(null);
    testDb?.close();
  });

  test("createMessage wraps SDK call and returns response", async () => {
    const { client } = createMockClient("success");
    _setClientForTesting(client);

    const result = await createMessage(makeTestParams(), { caller: "test" });

    expect(result.id).toBe("msg_test_123");
    expect(result.content[0]).toEqual({ type: "text", text: "Hello, world!" });
    expect(result.usage.input_tokens).toBe(100);
  });

  test("retries on rate limit error and eventually succeeds", async () => {
    const { client, calls } = createMockClient("rate-limit-then-success", 2);
    _setClientForTesting(client);

    const result = await createMessage(makeTestParams(), { caller: "test-retry" });

    expect(result.id).toBe("msg_test_123");
    // Should have made 3 calls: 2 failures + 1 success
    expect(calls.length).toBe(3);
  });

  test("retries on internal server error (up to 3x)", async () => {
    const { client, calls } = createMockClient("server-error-then-success", 2);
    _setClientForTesting(client);

    const result = await createMessage(makeTestParams(), { caller: "test-server-retry" });

    expect(result.id).toBe("msg_test_123");
    expect(calls.length).toBe(3);
  });

  test("does not retry on non-retryable API errors (fails immediately)", async () => {
    const { client, calls } = createMockClient("always-fail");
    _setClientForTesting(client);

    await expect(createMessage(makeTestParams(), { caller: "test-no-retry" })).rejects.toThrow(
      "Bad request",
    );

    // Should have made exactly 1 call — no retries
    expect(calls.length).toBe(1);
  });

  test("records successful call to llm_calls table with correct values", async () => {
    const { client } = createMockClient("success");
    _setClientForTesting(client);

    await createMessage(makeTestParams(), {
      caller: "test-cost",
      emailId: "email-123",
      accountId: "acct-456",
    });

    const row = testDb.prepare("SELECT * FROM llm_calls LIMIT 1").get() as LlmCallRecord;

    expect(row).toBeTruthy();
    expect(row.model).toBe("claude-sonnet-4-20250514");
    expect(row.caller).toBe("test-cost");
    expect(row.email_id).toBe("email-123");
    expect(row.account_id).toBe("acct-456");
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(50);
    expect(row.cache_read_tokens).toBe(20);
    expect(row.cache_create_tokens).toBe(10);
    expect(row.success).toBe(1);
    expect(row.error_message).toBeNull();
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("cost calculation accounts for cache discounts correctly", async () => {
    const { client } = createMockClient("success");
    _setClientForTesting(client);

    await createMessage(makeTestParams("claude-sonnet-4-20250514"), { caller: "test-cost-math" });

    const row = testDb.prepare("SELECT cost_cents FROM llm_calls LIMIT 1").get() as {
      cost_cents: number;
    };

    // Sonnet pricing: input=$3/M, output=$15/M, cacheRead=$0.3/M, cacheWrite=$3.75/M
    // usage: 100 input (non-cached), 50 output, 20 cacheRead, 10 cacheWrite
    // API input_tokens already excludes cache tokens — they're separate fields
    // inputCost = 100 * 3.0 / 1_000_000 = 0.0003
    // outputCost = 50 * 15.0 / 1_000_000 = 0.00075
    // cacheReadCost = 20 * 0.3 / 1_000_000 = 0.000006
    // cacheWriteCost = 10 * 3.75 / 1_000_000 = 0.0000375
    // total $ = 0.0003 + 0.00075 + 0.000006 + 0.0000375 = 0.0010935
    // total cents = 0.10935
    expect(row.cost_cents).toBeCloseTo(0.10935, 4);
  });

  test("timeout via AbortController aborts the request", async () => {
    // Create a client that takes too long
    const client = {
      messages: {
        create: async (_params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          // Wait for abort signal or a long time
          return new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Should have been aborted")), 10000);
            options?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted", "AbortError"));
            });
          });
        },
      },
    };
    _setClientForTesting(client);

    await expect(
      createMessage(makeTestParams(), { caller: "test-timeout", timeoutMs: 50 }),
    ).rejects.toThrow(/abort/i);
  });

  test("records failed call with error_message", async () => {
    const { client } = createMockClient("always-fail");
    _setClientForTesting(client);

    await expect(
      createMessage(makeTestParams(), { caller: "test-error-record" }),
    ).rejects.toThrow();

    const row = testDb.prepare("SELECT * FROM llm_calls LIMIT 1").get() as LlmCallRecord;

    expect(row).toBeTruthy();
    expect(row.success).toBe(0);
    expect(row.error_message).toContain("Bad request");
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
  });

  test("getUsageStats returns correct aggregation", async () => {
    const { client } = createMockClient("success");
    _setClientForTesting(client);

    // Make a few calls
    await createMessage(makeTestParams(), { caller: "analyzer" });
    await createMessage(makeTestParams(), { caller: "analyzer" });
    await createMessage(makeTestParams(), { caller: "drafter" });

    const stats = getUsageStats();

    expect(stats.today.totalCalls).toBe(3);
    expect(stats.today.totalCostCents).toBeGreaterThan(0);
    expect(stats.thisWeek.totalCalls).toBe(3);
    expect(stats.thisMonth.totalCalls).toBe(3);

    // byCaller should have 2 entries
    expect(stats.byCaller).toHaveLength(2);
    const analyzerEntry = stats.byCaller.find((e) => e.caller === "analyzer");
    expect(analyzerEntry?.calls).toBe(2);
    const drafterEntry = stats.byCaller.find((e) => e.caller === "drafter");
    expect(drafterEntry?.calls).toBe(1);
  });

  test("getCallHistory returns records in descending order", async () => {
    const { client } = createMockClient("success");
    _setClientForTesting(client);

    await createMessage(makeTestParams(), { caller: "first" });
    await createMessage(makeTestParams(), { caller: "second" });
    await createMessage(makeTestParams(), { caller: "third" });

    const history = getCallHistory(10);

    expect(history).toHaveLength(3);
    // Most recent first
    expect(history[0].caller).toBe("third");
    expect(history[1].caller).toBe("second");
    expect(history[2].caller).toBe("first");
  });

  test("getUsageStats returns zeroes when no calls recorded", () => {
    const stats = getUsageStats();

    expect(stats.today.totalCalls).toBe(0);
    expect(stats.today.totalCostCents).toBe(0);
    expect(stats.byModel).toHaveLength(0);
    expect(stats.byCaller).toHaveLength(0);
  });

  test("getCallHistory returns empty array when no calls recorded", () => {
    const history = getCallHistory();
    expect(history).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DeepSeek OpenAI-compatible native path
//
// DeepSeek is spoken over its OpenAI-compatible /chat/completions endpoint via
// a raw fetch (not the Anthropic SDK). These tests stub global.fetch to assert
// the request shape (URL, Bearer auth, OpenAI body) and that the OpenAI-shaped
// response is synthesized back into an Anthropic Message with correct token
// accounting and provider attribution.
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeOpenAIResponse(overrides?: {
  content?: string;
  reasoning?: string;
  usage?: Record<string, number>;
}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: "deepseek-v4-pro",
      choices: [
        {
          message: {
            content: overrides?.content ?? "DeepSeek says hi",
            reasoning_content: overrides?.reasoning,
          },
          finish_reason: "stop",
        },
      ],
      usage: overrides?.usage ?? {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 20,
        prompt_cache_miss_tokens: 80,
      },
    }),
    text: async () => "",
  } as unknown as Response;
}

test.describe("DeepSeek native path", () => {
  test.skip(!!nativeModuleError, `Skipping: ${nativeModuleError}`);

  let testDb: DB;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: FetchCall[];

  test.beforeEach(() => {
    testDb = new DatabaseCtor!(":memory:");
    setAnthropicServiceDb(testDb);
    setDeepSeekConfig("test-deepseek-key");
    fetchCalls = [];
    originalFetch = globalThis.fetch;
  });

  test.afterEach(() => {
    globalThis.fetch = originalFetch;
    setDeepSeekConfig("");
    testDb?.close();
  });

  test("hits the OpenAI-compatible endpoint with Bearer auth and OpenAI body", async () => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return makeOpenAIResponse();
    }) as unknown as typeof globalThis.fetch;

    const result = await createMessage(
      {
        model: "deepseek-v4-pro",
        max_tokens: 256,
        system: "You are helpful",
        messages: [{ role: "user", content: "Hello" }],
      },
      { caller: "analyzer", provider: "deepseek" },
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://api.deepseek.com/chat/completions");
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-deepseek-key");
    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.stream).toBe(false);
    // System prompt is flattened into a leading system message
    expect(body.messages[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(body.messages[1]).toEqual({ role: "user", content: "Hello" });

    // Response synthesized into an Anthropic-style message
    expect(result.content[0]).toEqual({ type: "text", text: "DeepSeek says hi", citations: null });
  });

  test("maps OpenAI usage onto Anthropic token fields (cache hit vs miss)", async () => {
    globalThis.fetch = (async () => makeOpenAIResponse()) as unknown as typeof globalThis.fetch;

    await createMessage({ model: "deepseek-v4-pro", max_tokens: 256, messages: [] }, {
      caller: "analyzer",
      provider: "deepseek",
    });

    const row = testDb.prepare("SELECT * FROM llm_calls LIMIT 1").get() as LlmCallRecord & {
      provider: string;
    };
    // miss tokens → input; hit tokens → cache_read; no cache-write on DeepSeek
    expect(row.input_tokens).toBe(80);
    expect(row.cache_read_tokens).toBe(20);
    expect(row.output_tokens).toBe(50);
    expect(row.cache_create_tokens).toBe(0);
    expect(row.provider).toBe("deepseek");
    expect(row.cost_cents).toBeGreaterThan(0);
  });

  test("surfaces reasoning_content as a trailing thinking block", async () => {
    globalThis.fetch = (async () =>
      makeOpenAIResponse({
        content: "the answer",
        reasoning: "let me think",
      })) as unknown as typeof globalThis.fetch;

    const result = await createMessage(
      { model: "deepseek-v4-pro", max_tokens: 256, messages: [{ role: "user", content: "q" }] },
      { caller: "drafter", provider: "deepseek" },
    );

    // Text stays at [0] so callers reading content[0] still work; thinking trails
    expect(result.content[0]).toEqual({ type: "text", text: "the answer", citations: null });
    expect(result.content[1]?.type).toBe("thinking");
  });

  test("byProvider aggregation attributes DeepSeek calls", async () => {
    globalThis.fetch = (async () => makeOpenAIResponse()) as unknown as typeof globalThis.fetch;

    await createMessage({ model: "deepseek-v4-pro", max_tokens: 256, messages: [] }, {
      caller: "analyzer",
      provider: "deepseek",
    });

    const stats = getUsageStats();
    const deepseekEntry = stats.byProvider.find((p) => p.provider === "deepseek");
    expect(deepseekEntry?.calls).toBe(1);
  });

  test("maps HTTP errors to retryable/non-retryable behavior", async () => {
    // 400 is non-retryable — should fail immediately after a single call
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 400, text: async () => "bad request" } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    await expect(
      createMessage({ model: "deepseek-v4-pro", max_tokens: 256, messages: [] }, {
        caller: "analyzer",
        provider: "deepseek",
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
