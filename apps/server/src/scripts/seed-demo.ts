/**
 * Fills a database with a month of plausible test history.
 *
 *   pnpm --filter @camerihq/server exec tsx src/scripts/seed-demo.ts
 *
 * This exists for the screenshots on the website, and the bar it has to clear
 * is that nobody looking at them thinks "that is fake data". Real suites are
 * lopsided: a handful of tests account for most of the pain, a couple are
 * reliably unreliable, one broke on a Tuesday and stayed red until somebody
 * noticed, and the rest simply pass. Uniform random noise looks nothing like
 * it — and neither does a wall of red, which is what the first pass produced.
 * Most builds on a healthy repo are green; the interesting ones are the few
 * that are not, and a dashboard is worth having because it finds those.
 *
 * Everything is generated from a fixed seed, so the same command twice gives
 * the same dashboard and a re-shot screenshot does not become a diff.
 *
 * It deletes the project it is about to write. Do not point it at anything you
 * care about.
 */
import { randomUUID } from "node:crypto";
import { errorSignature } from "@camerihq/core";
import type { RunStats, TestStep } from "@camerihq/contract";
import {
  attachments,
  createDatabase,
  projects,
  runs,
  shards,
  testAttempts,
  tests,
  type Database,
} from "@camerihq/db";
import { loadDotenv } from "@camerihq/db/dotenv";
import { eq } from "drizzle-orm";

loadDotenv();

const SLUG = "acme-storefront";
const NAME = "Acme Storefront";
// A month, because the explorer's default window is 30 days and a fortnight of
// data draws a chart that is half empty gutter.
const DAYS = 30;
const SHARDS_PER_RUN = 4;

/**
 * Deterministic PRNG (mulberry32).
 *
 * `Math.random` would make every screenshot session produce a subtly different
 * dashboard, which turns "retake that one image" into "retake all of them".
 */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(20260824);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const between = (min: number, max: number): number => Math.floor(min + random() * (max - min));

interface TestSpec {
  file: string;
  suite: string;
  title: string;
  /** Baseline chance this test fails on any given attempt. */
  failRate: number;
  /** Chance a failure passes on retry — what makes a test read as flaky. */
  retryRecovery: number;
  slow?: boolean;
  /** Day index from which this test started failing outright, if it ever did. */
  brokeOnDay?: number;
  /** Day index the fix landed on. Without one the breakage runs to today. */
  fixedOnDay?: number;
  error?: { message: string; snippet: string };
}

const TIMEOUT = (what: string, ms: number) => ({
  message: `Test timeout of ${ms}ms exceeded.\n\nError: locator.click: Target closed\n  waiting for ${what}`,
  snippet: `  await expect(page.getByRole('button', { name: 'Place order' })).toBeEnabled();\n                                                                    ^`,
});

const SPECS: TestSpec[] = [
  // The long tail: dull, green, and most of the suite.
  ...[
    ["tests/catalog/search.spec.ts", "Search", "finds a product by name"],
    ["tests/catalog/search.spec.ts", "Search", "shows an empty state for nonsense"],
    ["tests/catalog/search.spec.ts", "Search", "keeps the query in the URL"],
    ["tests/catalog/filters.spec.ts", "Filters", "narrows by category"],
    ["tests/catalog/filters.spec.ts", "Filters", "combines price and brand"],
    ["tests/catalog/filters.spec.ts", "Filters", "clears every filter at once"],
    ["tests/catalog/pdp.spec.ts", "Product page", "renders the gallery"],
    ["tests/catalog/pdp.spec.ts", "Product page", "switches variant on colour change"],
    ["tests/catalog/pdp.spec.ts", "Product page", "shows stock for the selected size"],
    ["tests/auth/login.spec.ts", "Login", "signs in with a valid password"],
    ["tests/auth/login.spec.ts", "Login", "rejects a wrong password"],
    ["tests/auth/login.spec.ts", "Login", "remembers the redirect target"],
    ["tests/auth/signup.spec.ts", "Signup", "creates an account"],
    ["tests/auth/signup.spec.ts", "Signup", "refuses a duplicate email"],
    ["tests/account/profile.spec.ts", "Profile", "updates the display name"],
    ["tests/account/profile.spec.ts", "Profile", "changes the delivery address"],
    ["tests/account/orders.spec.ts", "Order history", "lists past orders"],
    ["tests/account/orders.spec.ts", "Order history", "opens an invoice"],
    ["tests/checkout/cart.spec.ts", "Cart", "adds a product"],
    ["tests/checkout/cart.spec.ts", "Cart", "updates the quantity"],
    ["tests/checkout/cart.spec.ts", "Cart", "removes the last line"],
    ["tests/checkout/shipping.spec.ts", "Shipping", "picks up in store"],
    ["tests/checkout/shipping.spec.ts", "Shipping", "quotes express delivery"],
    ["tests/admin/products.spec.ts", "Admin products", "publishes a draft"],
    ["tests/admin/products.spec.ts", "Admin products", "bulk edits prices"],
    ["tests/admin/orders.spec.ts", "Admin orders", "refunds a line"],
  ].map(([file, suite, title]) => ({
    file: file as string,
    suite: suite as string,
    title: title as string,
    failRate: 0.0015,
    retryRecovery: 0.5,
  })),

  // The two everybody knows about. High first-attempt failure, high recovery:
  // that combination is what "flaky" means, and it is why the flaky column is
  // worth having — neither the pass rate nor the fail rate shows it.
  {
    file: "tests/checkout/payment.spec.ts",
    suite: "Payment",
    title: "completes a card payment",
    failRate: 0.14,
    retryRecovery: 0.92,
    slow: true,
    error: TIMEOUT("the payment iframe to settle", 30000),
  },
  {
    file: "tests/catalog/search.spec.ts",
    suite: "Search",
    title: "debounces as you type",
    failRate: 0.11,
    retryRecovery: 0.9,
    error: {
      message:
        "expect(received).toHaveCount(expected)\n\nExpected: 3\nReceived: 4\n\nCall log:\n  - expect.toHaveCount with timeout 5000ms",
      snippet: "  await expect(page.getByTestId('suggestion')).toHaveCount(3);\n                                              ^",
    },
  },
  // Genuinely broken for four days last week, then fixed. A regression that is
  // still open would put every recent run in the red, which reads as a broken
  // demo rather than a broken test; healed is the more honest shape anyway,
  // and it leaves a scar on the trend chart that is the point of the chart.
  {
    file: "tests/checkout/payment.spec.ts",
    suite: "Payment",
    title: "applies a discount code",
    failRate: 0.01,
    retryRecovery: 0.1,
    brokeOnDay: DAYS - 8,
    fixedOnDay: DAYS - 4,
    error: {
      message:
        "expect(received).toBe(expected)\n\nExpected: \"£71.10\"\nReceived: \"£79.00\"",
      snippet: "  await expect(page.getByTestId('order-total')).toHaveText('£71.10');\n                                               ^",
    },
  },
  // Slow, occasionally over the line.
  {
    file: "tests/checkout/payment.spec.ts",
    suite: "Payment",
    title: "handles a declined card",
    failRate: 0.035,
    retryRecovery: 0.85,
    slow: true,
    error: TIMEOUT("the decline banner", 30000),
  },
];

const BROWSERS = ["chromium", "firefox", "webkit"] as const;

const BRANCHES = [
  { branch: "main", title: null as string | null, target: null as string | null, iid: null as string | null },
  { branch: "feat/express-checkout", title: "Express checkout for saved cards", target: "main", iid: "418" },
  { branch: "fix/search-debounce", title: "Debounce the suggestion request", target: "main", iid: "421" },
  { branch: "chore/bump-playwright", title: "Bump Playwright to 1.58", target: "main", iid: "423" },
  { branch: "feat/gift-cards", title: "Gift cards at checkout", target: "main", iid: "425" },
];

const AUTHORS = ["Dana Okonkwo", "Priya Raman", "Ludo Fischer", "Sam Whitfield", "Noor Haddad"];

const COMMITS = [
  "Cache the price matrix per variant",
  "Drop the legacy cart cookie",
  "Await the iframe before asserting on totals",
  "Reduce the suggestion debounce to 150ms",
  "Move order totals to the server",
  "Split checkout into its own bundle",
  "Retry the payment webhook once",
  "Tidy the product grid skeleton",
];

/** A stack that looks like one, pointing at the test that produced it. */
function stackFor(spec: TestSpec, message: string): string {
  return [
    `Error: ${message.split("\n")[0]}`,
    `    at ${spec.file}:${between(12, 90)}:${between(3, 40)}`,
    `    at TestFunction (${spec.file}:${between(8, 20)}:5)`,
  ].join("\n");
}

function stepsFor(spec: TestSpec, startedAt: Date, failed: boolean): TestStep[] {
  const titles = [
    ["Before Hooks", "hook"],
    ["page.goto('/checkout')", "pw:api"],
    [`test.step: ${spec.suite.toLowerCase()}`, "test.step"],
    ["expect.toBeVisible", "expect"],
    ["After Hooks", "hook"],
  ] as const;

  let offset = 0;
  return titles.map(([title, category], index) => {
    const durationMs = between(40, 900);
    const step: TestStep = {
      title,
      category,
      depth: category === "expect" ? 1 : 0,
      startedAt: new Date(startedAt.getTime() + offset).toISOString(),
      durationMs,
      error: failed && index === 3 ? (spec.error?.message.split("\n")[0] ?? "assertion failed") : null,
    };
    offset += durationMs;
    return step;
  });
}

async function seed(db: Database): Promise<void> {
  const [existing] = await db.select().from(projects).where(eq(projects.slug, SLUG)).limit(1);
  if (existing) {
    // Cascades through runs, shards, attempts and attachments.
    await db.delete(projects).where(eq(projects.id, existing.id));
  }

  const [project] = await db.insert(projects).values({ slug: SLUG, name: NAME }).returning();
  if (!project) throw new Error("project insert returned nothing");

  // One `tests` row per (spec, browser) — the same identity the reporter would
  // produce, since Playwright's project name is part of the test id.
  const catalogue = SPECS.flatMap((spec) =>
    BROWSERS.map((browser) => ({
      spec,
      browser,
      testId: `${spec.file}:${spec.suite}:${spec.title}:${browser}`,
    })),
  );

  const testRows = await db
    .insert(tests)
    .values(
      catalogue.map(({ spec, browser, testId }) => ({
        projectId: project.id,
        testId,
        title: spec.title,
        titlePath: [spec.suite, spec.title],
        file: spec.file,
        projectName: browser,
      })),
    )
    .returning({ id: tests.id, testId: tests.testId });

  const testIdByKey = new Map(testRows.map((row) => [row.testId, row.id]));

  const now = new Date();
  const runValues: (typeof runs.$inferInsert)[] = [];
  const shardValues: (typeof shards.$inferInsert)[] = [];
  const attemptValues: (typeof testAttempts.$inferInsert)[] = [];
  const attachmentValues: (typeof attachments.$inferInsert)[] = [];

  let runNumber = 0;

  for (let day = 0; day < DAYS; day += 1) {
    // Fewer builds at the weekend, which is what a real chart looks like.
    const dayStart = new Date(now.getTime() - (DAYS - 1 - day) * 86_400_000);
    const weekend = dayStart.getDay() === 0 || dayStart.getDay() === 6;
    const buildsToday = weekend ? between(1, 3) : between(4, 8);

    for (let build = 0; build < buildsToday; build += 1) {
      runNumber += 1;
      const source = pick(BRANCHES);
      const startedAt = new Date(
        dayStart.getTime() - dayStart.getHours() * 3_600_000 + (9 + build * 1.4) * 3_600_000,
      );
      // The most recent build is still going, so the dashboard has something
      // live on it rather than reading like an archive.
      const live = day === DAYS - 1 && build === buildsToday - 1;

      const runId = randomUUID();
      const runStats: RunStats = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0 };

      for (let shardIndex = 1; shardIndex <= SHARDS_PER_RUN; shardIndex += 1) {
        const shardId = randomUUID();
        const shardLive = live && shardIndex > 2;
        const shardStats: RunStats = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0 };
        let cursor = new Date(startedAt.getTime() + between(4_000, 20_000));

        for (const entry of catalogue) {
          // Deal the suite out across shards the way Playwright does.
          if (catalogue.indexOf(entry) % SHARDS_PER_RUN !== shardIndex - 1) continue;

          const { spec, browser, testId } = entry;
          const testRef = testIdByKey.get(testId);
          if (!testRef) continue;

          // A shard still running has simply not reached the rest of its tests.
          if (shardLive && random() < 0.45) continue;

          const broken =
            spec.brokeOnDay !== undefined &&
            day >= spec.brokeOnDay &&
            day < (spec.fixedOnDay ?? Number.POSITIVE_INFINITY);
          // webkit is the browser everyone's flake lives in.
          const browserPenalty = browser === "webkit" ? 1.9 : browser === "firefox" ? 1.2 : 1;
          const failChance = broken ? 0.97 : Math.min(0.9, spec.failRate * browserPenalty);

          if (!broken && random() < 0.012) {
            attemptValues.push({
              id: randomUUID(),
              runId,
              shardId,
              testRef,
              projectId: project.id,
              status: "skipped",
              retry: 0,
              durationMs: 0,
              startedAt: cursor,
              parallelIndex: shardIndex % 4,
              workerIndex: shardIndex,
              annotations: [{ type: "skip", description: "unstable on CI" }],
              tags: ["@smoke"],
              steps: [],
              createdAt: cursor,
            });
            shardStats.total += 1;
            shardStats.skipped += 1;
            continue;
          }

          const baseDuration = spec.slow ? between(4_200, 12_000) : between(280, 3_400);
          let failedFirst = random() < failChance;
          const recovered = failedFirst && !broken && random() < spec.retryRecovery;
          const retries = failedFirst ? (recovered ? 1 : 2) : 0;

          for (let retry = 0; retry <= retries; retry += 1) {
            const isLast = retry === retries;
            const failedThisAttempt = failedFirst && !(recovered && isLast);
            const durationMs = failedThisAttempt && spec.error ? between(5_000, 30_000) : baseDuration;
            const attemptId = randomUUID();
            const message = spec.error?.message ?? "expect(received).toBeVisible()\n\nReceived: hidden";

            attemptValues.push({
              id: attemptId,
              runId,
              shardId,
              testRef,
              projectId: project.id,
              status: failedThisAttempt ? (spec.slow && random() < 0.5 ? "timedOut" : "failed") : "passed",
              retry,
              durationMs,
              startedAt: cursor,
              parallelIndex: shardIndex % 4,
              workerIndex: shardIndex,
              errorMessage: failedThisAttempt ? message : null,
              errorStack: failedThisAttempt ? stackFor(spec, message) : null,
              errorSnippet: failedThisAttempt ? (spec.error?.snippet ?? null) : null,
              errorSignature: failedThisAttempt ? errorSignature({ message, stack: stackFor(spec, message) }) : null,
              tags: spec.suite === "Payment" ? ["@checkout", "@critical"] : ["@smoke"],
              stdout: failedThisAttempt ? "[pw] navigating to /checkout\n[pw] waiting for #pay\n" : null,
              steps: stepsFor(spec, cursor, failedThisAttempt),
              isFlaky: recovered && isLast,
              // Backdated explicitly. `created_at` defaults to `now()`, and the
              // explorer windows the history on it — leave it and every test in
              // a fortnight of data claims it last ran a minute ago, with 7d,
              // 30d and 90d all showing the same numbers.
              createdAt: cursor,
            });

            if (failedThisAttempt) {
              for (const [name, kind, contentType, size] of [
                ["trace.zip", "trace", "application/zip", between(240_000, 3_400_000)],
                ["test-failed-1.png", "screenshot", "image/png", between(40_000, 320_000)],
              ] as const) {
                attachmentValues.push({
                  attemptId,
                  name,
                  kind,
                  contentType,
                  sizeBytes: size,
                  storageKey: `${runId}/${attemptId}/${name}`,
                  uploadedAt: new Date(cursor.getTime() + durationMs + 1_200),
                });
              }
            }

            cursor = new Date(cursor.getTime() + durationMs + between(60, 400));
            shardStats.durationMs += durationMs;

            if (isLast) {
              shardStats.total += 1;
              if (failedThisAttempt) shardStats.failed += 1;
              else if (recovered) shardStats.flaky += 1;
              else shardStats.passed += 1;
            }
            if (recovered && isLast) failedFirst = false;
          }
        }

        const shardCompleted = shardLive ? null : new Date(cursor.getTime() + between(1_000, 9_000));
        shardValues.push({
          id: shardId,
          runId,
          shardIndex,
          status: shardLive ? "running" : shardStats.failed > 0 ? "failed" : "completed",
          stats: shardStats,
          startedAt,
          completedAt: shardCompleted,
          lastSeenAt: shardCompleted ?? new Date(cursor.getTime()),
          createdAt: startedAt,
        });

        runStats.total += shardStats.total;
        runStats.passed += shardStats.passed;
        runStats.failed += shardStats.failed;
        runStats.skipped += shardStats.skipped;
        runStats.flaky += shardStats.flaky;
        runStats.durationMs = Math.max(runStats.durationMs, shardStats.durationMs);
      }

      const completedAt = live ? null : new Date(startedAt.getTime() + runStats.durationMs + between(20_000, 90_000));

      runValues.push({
        id: runId,
        projectId: project.id,
        runKey: `gl-${4_100_000 + runNumber}`,
        status: live ? "running" : runStats.failed > 0 ? "failed" : "passed",
        expectedShards: SHARDS_PER_RUN,
        playwrightVersion: "1.58.0",
        branch: source.branch,
        commitSha: [...Array(40)].map(() => "0123456789abcdef"[between(0, 16)]).join(""),
        commitMessage: pick(COMMITS),
        author: pick(AUTHORS),
        remoteUrl: "https://gitlab.com/acme/storefront",
        ciProvider: "gitlab",
        ciBuildId: String(4_100_000 + runNumber),
        ciBuildUrl: `https://gitlab.com/acme/storefront/-/pipelines/${4_100_000 + runNumber}`,
        ciJobName: "e2e",
        mrProvider: source.iid ? "gitlab" : null,
        mrProjectId: source.iid ? "acme/storefront" : null,
        mrIid: source.iid,
        mrTitle: source.title,
        mrTargetBranch: source.target,
        mrServerUrl: source.iid ? "https://gitlab.com" : null,
        mrUrl: source.iid ? `https://gitlab.com/acme/storefront/-/merge_requests/${source.iid}` : null,
        metadata: {},
        startedAt,
        completedAt,
        staleAt: new Date(startedAt.getTime() + 7_200_000),
        createdAt: startedAt,
      });
    }
  }

  await db.insert(runs).values(runValues);
  await db.insert(shards).values(shardValues);

  // Chunked: a single insert of tens of thousands of rows blows past the
  // parameter limit the driver will accept.
  for (let index = 0; index < attemptValues.length; index += 500) {
    await db.insert(testAttempts).values(attemptValues.slice(index, index + 500));
  }
  for (let index = 0; index < attachmentValues.length; index += 500) {
    await db.insert(attachments).values(attachmentValues.slice(index, index + 500));
  }

  console.log(
    `seeded ${NAME}: ${runValues.length} runs, ${shardValues.length} shards, ` +
      `${attemptValues.length} attempts, ${testRows.length} tests`,
  );
}

const { db, close } = createDatabase({
  url: process.env.DATABASE_URL ?? "postgres://cameri:cameri@localhost:5432/cameri",
  ssl: false,
});

try {
  await seed(db);
} finally {
  await close();
}
