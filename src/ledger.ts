import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { MIN_INTERVAL_MS } from "./config.ts";

const PATH = "data/ledger.json";

export interface LedgerEntry {
  agentId: string;
  promptHash: string;
  nonce: string;
  requestDigest: string;
  settleDigest?: string;
  walrusBlobId?: string;
  at: string;
}

interface LedgerFile {
  lastSentAt: number;
  attacks: LedgerEntry[];
}

function empty(): LedgerFile {
  return { lastSentAt: 0, attacks: [] };
}

export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export async function readLedger(): Promise<LedgerFile> {
  try {
    return JSON.parse(await readFile(PATH, "utf8")) as LedgerFile;
  } catch {
    return empty();
  }
}

export async function waitForPace(): Promise<void> {
  const ledger = await readLedger();
  const elapsed = Date.now() - ledger.lastSentAt;
  const remaining = MIN_INTERVAL_MS - elapsed;
  if (remaining <= 0) return;
  if (remaining > MIN_INTERVAL_MS) {
    throw new Error("Ledger lastSentAt is in the future. Fix data/ledger.json before sending.");
  }
  console.error(`Waiting ${Math.ceil(remaining / 1000)}s so this send stays human-paced.`);
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, remaining);
  await promise;
}

export async function assertFresh(agentId: string, prompt: string): Promise<void> {
  const hash = promptHash(prompt);
  const ledger = await readLedger();
  const prior = ledger.attacks.find(
    (entry) => entry.agentId === agentId && entry.promptHash === hash,
  );
  if (prior) {
    throw new Error(
      `This prompt was already sent to agent ${agentId} at ${prior.at}. Identical retries do not count.`,
    );
  }
}

export async function recordSend(entry: LedgerEntry): Promise<void> {
  const ledger = await readLedger();
  ledger.lastSentAt = Date.now();
  ledger.attacks.push(entry);
  await mkdir("data", { recursive: true });
  await writeFile(PATH, JSON.stringify(ledger, null, 2));
}

export async function markSettled(
  nonce: string,
  patch: Partial<Pick<LedgerEntry, "settleDigest" | "walrusBlobId">>,
): Promise<void> {
  const ledger = await readLedger();
  const entry = ledger.attacks.find((item) => item.nonce === nonce);
  if (!entry) return;
  Object.assign(entry, patch);
  await mkdir("data", { recursive: true });
  await writeFile(PATH, JSON.stringify(ledger, null, 2));
}
