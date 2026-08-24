import { createHash } from "node:crypto";
import type { TestError } from "@camerihq/contract";

const ANSI = /\[[0-9;]*m/g;
const HEX = /0x[0-9a-f]+/gi;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Deliberately not \b-anchored: the volatile parts are things like "5000ms" and
// ":4173", where the digits sit flush against a letter or symbol.
const NUMBERS = /\d+/g;
const ABS_PATHS = /(?:\/[\w.-]+)+\/(?=[\w.-]+\.[jt]sx?)/g;
const TIMESTAMPS = /\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g;

/**
 * Collapses the volatile parts of an error message — ports, timings, temp paths,
 * object ids — so that "the same failure" clusters together across runs and
 * machines. Deliberately lossy; it is a grouping key, not a diagnostic.
 */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(ANSI, "")
    .replace(TIMESTAMPS, "<ts>")
    .replace(UUID, "<uuid>")
    .replace(HEX, "<hex>")
    .replace(ABS_PATHS, "")
    .replace(NUMBERS, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * Stable id for a failure cluster. Includes the first stack frame when we have
 * one, because the same assertion text from two different call sites is usually
 * two different bugs.
 */
export function errorSignature(error: Pick<TestError, "message" | "stack">): string {
  const normalized = normalizeErrorMessage(error.message);
  const frame = firstUserFrame(error.stack ?? "");
  return createHash("sha256").update(`${normalized}\n${frame}`).digest("hex").slice(0, 16);
}

/** First stack frame that is not node internals or node_modules. */
export function firstUserFrame(stack: string): string {
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    if (line.includes("node_modules") || line.includes("node:internal")) continue;
    return line.replace(ABS_PATHS, "").replace(/:\d+:\d+/g, ":<n>:<n>");
  }
  return "";
}
