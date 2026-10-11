#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { chatHistory, consumePrompt, findAgent, listAgents } from "./api.ts";
import { quoteFee, requestAttack, settleAttack } from "./chain.ts";
import { grpcClient, loadSigner } from "./client.ts";
import {
  MAX_PROMPT_CHARS,
  MIN_INTERVAL_MS,
  SELF_BREACH_END,
  SELF_BREACH_START,
  SUI_COIN_TYPE,
} from "./config.ts";
import { assertFresh, markSettled, promptHash, recordSend, waitForPace } from "./ledger.ts";
import { storeAttackRecord } from "./walrus.ts";

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function has(name: string): boolean {
  return args.includes(name);
}

function mist(value: bigint | string, decimals = 9): string {
  const raw = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function usage(): never {
  console.log(`sentinel-attacker — local signer for RedSentinel Sui mainnet attacks

  list [--limit 20] [--offset 0] [--status active] [--tag <tag>] [--chain sui]
  show <id-or-path>
  history <id-or-path> [--limit 8]
  quote <id-or-path>
  whoami
  attack --target <id-or-path> (--prompt-file <file> | --prompt <text>) [--send] [--allow-own] [--skip-walrus]
  walrus --nonce <attack-nonce>

Without --send, attack prints the plan and does not sign.
Prompts come from you. This tool does not write them.
Sends are one at a time, at least ${MIN_INTERVAL_MS / 1000}s apart, and identical retries are refused.
Attacks count for the signing wallet. Extra wallets do not count for the Walrus session.
`);
  process.exit(command ? 1 : 0);
}

async function main(): Promise<void> {
  if (!command || command === "help" || has("--help")) usage();
  if (command === "list") return list();
  if (command === "show") return show(required(1));
  if (command === "history") return history(required(1));
  if (command === "quote") return quote(required(1));
  if (command === "whoami") return whoami();
  if (command === "attack") return attack();
  if (command === "walrus") return walrus(flag("--nonce") ?? usage());
  usage();
}

function required(index: number): string {
  const value = args[index];
  if (!value || value.startsWith("--")) usage();
  return value;
}

async function list(): Promise<void> {
  const page = await listAgents({
    limit: Number(flag("--limit") ?? 20),
    offset: Number(flag("--offset") ?? 0),
    chain: flag("--chain") ?? "sui",
    status: flag("--status") ?? "active",
    tag: flag("--tag"),
  });
  console.log(`showing ${page.agents.length} of ${page.total}`);
  for (const agent of page.agents) {
    console.log(
      [
        agent.agent_id.padStart(5),
        agent.state,
        agent.chain,
        `${mist(agent.current_cost_per_message)} fee`,
        `${mist(agent.total_balance)} pool`,
        `${agent.total_attacks} attacks`,
        agent.agent_name,
        agent.agent_path,
      ].join("  "),
    );
  }
}

async function show(target: string): Promise<void> {
  const agent = await findAgent(target);
  console.log(
    [
      `#${agent.agent_id} ${agent.agent_name}`,
      `path: ${agent.agent_path}`,
      `state: ${agent.state}  chain: ${agent.chain}  model: ${agent.model_provider} / ${agent.model_name}`,
      `creator: ${agent.creator}`,
      `object: ${agent.agent_object_id}`,
      `fee: ${mist(agent.current_cost_per_message)} (base ${mist(agent.cost_per_message)})  pool: ${mist(agent.total_balance)}  attacks: ${agent.total_attacks}`,
      `goal: ${agent.attack_goal}`,
      `public instructions: ${agent.prompt}`,
    ].join("\n"),
  );
}

async function history(target: string): Promise<void> {
  const agent = await findAgent(target);
  const limit = Number(flag("--limit") ?? 8);
  const messages = (await chatHistory(agent.agent_id)).slice(0, limit);
  if (messages.length === 0) {
    console.log(`#${agent.agent_id} has no public attacks yet`);
    return;
  }
  for (const message of messages) {
    console.log(
      [
        message.success ? "BREACH" : "held",
        `score ${message.score}`,
        message.sender,
        message.tx_digest,
        message.walrus_blob_id ? `walrus ${message.walrus_blob_id}` : "no walrus id",
      ].join("  "),
    );
    console.log(message.content.trim().slice(0, 240));
    console.log("---");
  }
}

async function quote(target: string): Promise<void> {
  const agent = await findAgent(target);
  const client = grpcClient();
  const sender = process.env.SENTINEL_PRIVATE_KEY
    ? loadSigner().toSuiAddress()
    : agent.creator;
  const fee = await quoteFee(client, {
    agentObjectId: agent.agent_object_id,
    coinType: agent.coin_type || SUI_COIN_TYPE,
    sender,
  });
  console.log(
    `#${agent.agent_id} on-chain fee ${mist(fee)} (indexer current ${mist(agent.current_cost_per_message)})`,
  );
}

async function whoami(): Promise<void> {
  const signer = loadSigner();
  const address = signer.toSuiAddress();
  const client = grpcClient();
  const sui = await client.getBalance({ owner: address });
  const wal = await client.getBalance({
    owner: address,
    coinType: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL",
  });
  console.log(address);
  console.log(`SUI ${mist(sui.balance.balance)}`);
  console.log(`WAL ${mist(wal.balance.balance)}`);
  console.log("Attacks you sign count for this address. A second wallet does not count for the session.");
}

async function readPrompt(): Promise<string> {
  const file = flag("--prompt-file");
  const inline = flag("--prompt");
  if (file && inline) throw new Error("Pass --prompt-file or --prompt, not both.");
  const prompt = file ? await readFile(file, "utf8") : inline;
  if (!prompt?.trim()) throw new Error("Prompt is empty.");
  const text = prompt.trim();
  if (text.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt is ${text.length} chars. Stay under ${MAX_PROMPT_CHARS} so it fits the 600-token cap.`);
  }
  return text;
}

async function attack(): Promise<void> {
  const target = flag("--target") ?? usage();
  const prompt = await readPrompt();
  const agent = await findAgent(target);
  if (agent.chain !== "sui") throw new Error(`Agent ${agent.agent_id} is on ${agent.chain}, not sui.`);
  if (agent.state !== "active") throw new Error(`Agent ${agent.agent_id} is ${agent.state}.`);

  const signer = has("--send") ? loadSigner() : trySigner();
  const sender = signer?.toSuiAddress();
  if (sender && sender.toLowerCase() === agent.creator.toLowerCase() && !has("--allow-own")) {
    throw new Error(
      "This agent is yours. Self-attacks do not count as attacker points. Self-breach scoring is only Oct 19–20. Pass --allow-own to send anyway.",
    );
  }
  if (sender && sender.toLowerCase() === agent.creator.toLowerCase()) {
    const now = Date.now();
    const inWindow = now >= SELF_BREACH_START && now < SELF_BREACH_END;
    console.error(
      inWindow
        ? "Self-breach window is open. This scores defender points only, not attacker points."
        : "Outside the Oct 19–20 self-breach window. This send will not score.",
    );
  }

  const prior = (await chatHistory(agent.agent_id)).find(
    (message) =>
      sender &&
      message.sender.toLowerCase() === sender.toLowerCase() &&
      message.content.trim() === prompt,
  );
  if (prior) {
    throw new Error(`You already sent this prompt to #${agent.agent_id} in ${prior.tx_digest}.`);
  }
  await assertFresh(agent.agent_id, prompt);

  const client = grpcClient();
  const fee = await quoteFee(client, {
    agentObjectId: agent.agent_object_id,
    coinType: agent.coin_type || SUI_COIN_TYPE,
    sender: sender ?? agent.creator,
  });
  console.log(`#${agent.agent_id} ${agent.agent_name}`);
  console.log(`object ${agent.agent_object_id}`);
  console.log(`on-chain fee ${mist(fee)}  listed fee ${mist(agent.current_cost_per_message)}  pool ${mist(agent.total_balance)}  prompt sha256 ${promptHash(prompt).slice(0, 12)}`);
  if (!has("--send")) {
    console.log("Dry run. Pass --send to sign request_attack, submit the prompt, and settle.");
    return;
  }
  if (!signer || !sender) throw new Error("Missing signer.");

  await waitForPace();
  console.error("Signing request_attack…");
  const ticket = await requestAttack(signer, client, {
    agentObjectId: agent.agent_object_id,
    coinType: agent.coin_type || SUI_COIN_TYPE,
    fee,
  });
  await recordSend({
    agentId: agent.agent_id,
    promptHash: promptHash(prompt),
    nonce: ticket.nonce,
    requestDigest: ticket.digest,
    at: new Date().toISOString(),
  });
  console.log(`ticket ${ticket.attackObjectId} nonce ${ticket.nonce} tx ${ticket.digest}`);

  console.error("Submitting prompt…");
  const tee = await consumePrompt({
    agentId: agent.agent_id,
    message: prompt,
    attackNonce: ticket.nonce,
    attacker: sender,
  });
  const data = tee.response.data;
  console.log(`verdict success=${data.success} score=${data.score}`);
  if (data.agent_response) console.log(data.agent_response);
  if (data.jury_response) console.log(`jury: ${data.jury_response}`);

  console.error("Signing consume_prompt…");
  const settleDigest = await settleAttack(signer, client, {
    agentObjectId: agent.agent_object_id,
    attackObjectId: ticket.attackObjectId,
    coinType: agent.coin_type || SUI_COIN_TYPE,
    tee,
  });
  await markSettled(ticket.nonce, { settleDigest });
  console.log(`settled ${settleDigest}`);

  if (has("--skip-walrus")) {
    console.log(`Walrus skipped. Retry with: bun src/cli.ts walrus --nonce ${ticket.nonce}`);
    return;
  }
  try {
    const stored = await storeAttackRecord(signer, client, ticket.nonce);
    await markSettled(ticket.nonce, { walrusBlobId: stored.blobId });
    console.log(`walrus ${stored.blobId} register ${stored.registerDigest}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Walrus storage failed: ${message}`);
    console.error(`Retry with: bun src/cli.ts walrus --nonce ${ticket.nonce}`);
  }
}

function trySigner() {
  try {
    return loadSigner();
  } catch {
    return null;
  }
}

async function walrus(nonce: string): Promise<void> {
  const signer = loadSigner();
  const stored = await storeAttackRecord(signer, grpcClient(), nonce);
  await markSettled(nonce, { walrusBlobId: stored.blobId });
  console.log(`walrus ${stored.blobId}`);
  console.log(`register ${stored.registerDigest}`);
  console.log(`certify ${stored.certifyDigest}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
