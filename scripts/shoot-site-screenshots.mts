/**
 * Photographs the dashboard for the website.
 *
 *   node --import tsx scripts/shoot-site-screenshots.mts
 *
 * Expects a server already running against a seeded database — see
 * `apps/server/src/scripts/seed-demo.ts` and the recipe in `site/README.md`.
 * Override the origin with `CAMERI_ORIGIN`.
 *
 * Driving a real Chromium rather than asking a screenshot service for a URL,
 * because half of what makes these pages worth showing arrives after the first
 * paint: the run list streams, the charts animate in, and a naive capture gets
 * a page of skeletons. Every shot here waits for something specific to be on
 * screen and then waits for the animations to settle.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "site", "screenshots");
const origin = process.env.CAMERI_ORIGIN ?? "http://localhost:3100";
const project = process.env.CAMERI_PROJECT ?? "acme-storefront";

/** Retina, and a laptop-shaped viewport — these are shown at half size. */
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;

/**
 * Everything that would make two captures of the same page differ.
 *
 * Without this the charts are caught mid-transition and the "3 minutes ago"
 * column reads differently every run, so a re-shoot of one image turns into a
 * diff across all of them.
 */
const FREEZE_MOTION = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
`;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  // One more frame after the last response, so anything sized from layout —
  // the history bars, the sheet's slide-in — has settled at its final height.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
  await page.waitForTimeout(400);
}

async function shoot(
  page: Page,
  name: string,
  path: string,
  waitFor: string,
  /** Trims the shot to the top N pixels. For pages that end well above the fold. */
  height?: number,
): Promise<void> {
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
  await page.locator(waitFor).first().waitFor({ state: "visible", timeout: 20_000 });
  await settle(page);
  await page.screenshot({
    path: join(outDir, `${name}.png`),
    clip: height ? { x: 0, y: 0, width: VIEWPORT.width, height } : undefined,
  });
  console.log(`  ${name}.png`);
}

async function query<T>(procedure: string, input: unknown): Promise<T> {
  const encoded = encodeURIComponent(JSON.stringify(input));
  const response = await fetch(`${origin}/trpc/${procedure}?input=${encoded}`);
  if (!response.ok) throw new Error(`${procedure}: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { result: { data: T } }).result.data;
}

/**
 * The finished run with the most failures.
 *
 * Not simply the most recent red one: the seed is mostly green, so that is
 * usually a single flake, and a run detail page with one red row does not show
 * what the page is for.
 */
async function failedRunId(): Promise<string> {
  const rows = await query<{ id: string; status: string; failed: number }[]>("runs.list", {
    projectSlug: project,
    limit: 100,
  });
  const [run] = rows.filter((row) => row.status === "failed").sort((a, b) => b.failed - a.failed);
  if (!run) throw new Error("no failed run in the seed — the screenshots would be boring");
  console.log(`  run detail: ${run.id} (${run.failed} failed)`);
  return run.id;
}

/**
 * The merge request with the most pipelines behind it, so the runs tab has
 * something to show. An MR with two runs makes the page look like the list.
 */
async function busiestMrIid(): Promise<string> {
  const rows = await query<{ iid: string; runCount: number }[]>("mergeRequests.list", {
    projectSlug: project,
    limit: 50,
  });
  const [mr] = [...rows].sort((a, b) => b.runCount - a.runCount);
  if (!mr) throw new Error("no merge requests in the seed");
  console.log(`  merge request: !${mr.iid} (${mr.runCount} runs)`);
  return mr.iid;
}

/**
 * A flaky test to open the detail sheet on — one with both failures and
 * recoveries, so the history chart has three colours in it rather than one.
 */
async function flakiestTestRef(): Promise<string> {
  const rows = await query<{ testRef: string; title: string; flaky: number }[]>("tests.explorer", {
    projectSlug: project,
    days: 30,
    limit: 100,
  });
  const [test] = [...rows].sort((a, b) => b.flaky - a.flaky);
  if (!test) throw new Error("no tests in the seed");
  console.log(`  test sheet: ${test.title} (${test.flaky} flaky)`);
  return test.testRef;
}

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: SCALE,
  colorScheme: "dark",
  reducedMotion: "reduce",
});

// Dark, deliberately: it is what the app opens in, and it is what the site is
// built around. Set before the first navigation so there is no light flash.
await context.addInitScript(() => localStorage.setItem("cameri-theme", "dark"));
await context.addStyleTag?.({ content: FREEZE_MOTION }).catch(() => {});

const page = await context.newPage();
await page.addStyleTag({ content: FREEZE_MOTION }).catch(() => {});
page.on("console", (message) => {
  if (message.type() === "error") console.warn(`  ! console: ${message.text()}`);
});

console.log(`shooting ${origin} → site/screenshots`);

const [runId, mrIid, testRef] = await Promise.all([
  failedRunId(),
  busiestMrIid(),
  flakiestTestRef(),
]);

await shoot(page, "runs", `/${project}/runs`, "table tbody tr");
await shoot(page, "run", `/${project}/runs/${runId}`, "table tbody tr, [role='tablist']");
await shoot(page, "tests", `/${project}/tests`, "table tbody tr");
// The merge request *detail*, not the list: with a handful of MRs the list is
// four rows above a screenful of nothing, which photographs badly.
await shoot(page, "merge-request", `/${project}/mrs/${mrIid}`, "table tbody tr");
// The sheet opens straight from the URL, which is the whole point of keeping
// view state there — no clicking required to reproduce this shot.
await shoot(
  page,
  "test-history",
  `/${project}/tests?test=${testRef}&testTab=history`,
  // The bar track inside the sheet. The chart is hand-drawn flex boxes, so
  // there is no library class to hang this on.
  "[role='dialog'] div.h-40",
  620,
);

await browser.close();
console.log("done");
