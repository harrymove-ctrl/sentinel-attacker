import { fromHex, toHex } from "@mysten/bcs";
import type { Signer } from "@mysten/sui/cryptography";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  AGENT_REGISTRY,
  CLOCK_ID,
  MODULE_NAME,
  PACKAGE_ID,
  PROTOCOL_CONFIG_ID,
  RANDOM_ID,
} from "./config.ts";
import type { TeeResponse } from "./api.ts";

const ABORT: Record<string, string> = {
  "4": "The agent's price moved while this attack was submitted. Quote again and retry.",
  "17": "This token is not accepted by the protocol.",
  "18": "This sentinel is withdrawing and is not accepting attacks.",
  "19": "The protocol is paused.",
  "24": "This sentinel has already been defeated.",
};

export function explainAbort(message: string): string {
  const code = message.match(/,\s*(\d+)\)\s*in command/)?.[1];
  return (code && ABORT[code]) || message;
}

export async function quoteFee(
  client: SuiGrpcClient,
  input: { agentObjectId: string; coinType: string; sender: string },
): Promise<bigint> {
  const tx = new Transaction();
  tx.setSender(input.sender);
  tx.moveCall({
    target: `${PACKAGE_ID}::${MODULE_NAME}::get_effective_cost`,
    typeArguments: [input.coinType],
    arguments: [tx.object(input.agentObjectId), tx.object(PROTOCOL_CONFIG_ID)],
  });
  const sim = await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
  });
  if (sim.$kind === "FailedTransaction") {
    throw new Error(
      `Fee quote failed: ${sim.FailedTransaction.status.error?.message ?? "simulation failed"}`,
    );
  }
  const bytes = sim.commandResults?.[0]?.returnValues?.[0]?.bcs;
  if (!bytes || bytes.length < 8) throw new Error("Fee quote returned no u64");
  let fee = 0n;
  for (let i = 7; i >= 0; i--) fee = (fee << 8n) | BigInt(bytes[i]);
  return fee;
}

async function execute(signer: Signer, client: SuiGrpcClient, tx: Transaction) {
  tx.setSenderIfNotSet(signer.toSuiAddress());
  tx.setGasPayment([]);
  const result = await signer.signAndExecuteTransaction({ transaction: tx, client });
  if (result.$kind === "FailedTransaction") {
    const message = result.FailedTransaction.status.error?.message ?? "transaction failed";
    throw new Error(explainAbort(message));
  }
  await client.waitForTransaction({ digest: result.Transaction.digest });
  return result.Transaction;
}

export async function requestAttack(
  signer: Signer,
  client: SuiGrpcClient,
  input: { agentObjectId: string; coinType: string; fee: bigint },
): Promise<{ digest: string; attackObjectId: string; nonce: string }> {
  const sender = signer.toSuiAddress();
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasPayment([]);
  const payment =
    input.fee === 0n
      ? tx.moveCall({
          target: "0x2::coin::zero",
          typeArguments: [input.coinType],
        })
      : tx.coin({ type: input.coinType, amount: input.fee, useGasCoin: false });
  const [ticket] = tx.moveCall({
    target: `${PACKAGE_ID}::${MODULE_NAME}::request_attack`,
    typeArguments: [input.coinType],
    arguments: [
      tx.object(AGENT_REGISTRY),
      tx.object(input.agentObjectId),
      tx.object(PROTOCOL_CONFIG_ID),
      payment,
      tx.object(RANDOM_ID),
      tx.object(CLOCK_ID),
    ],
  });
  tx.transferObjects([ticket], sender);

  const executed = await execute(signer, client, tx);
  const created =
    executed.effects?.changedObjects.filter((object) => object.idOperation === "Created") ??
    [];
  for (const object of created) {
    if (object.outputState === "DoesNotExist") continue;
    let got;
    try {
      got = await client.getObject({
        objectId: object.objectId,
        include: { json: true },
      });
    } catch {
      continue;
    }
    if (!got.object.type.includes(`::${MODULE_NAME}::Attack`)) continue;
    const nonce = readNonce(got.object.json);
    if (!nonce) throw new Error(`Attack ticket ${object.objectId} has no nonce field`);
    return { digest: executed.digest, attackObjectId: object.objectId, nonce };
  }
  throw new Error(`request_attack ${executed.digest} did not create an Attack ticket`);
}

export async function settleAttack(
  signer: Signer,
  client: SuiGrpcClient,
  input: {
    agentObjectId: string;
    attackObjectId: string;
    coinType: string;
    tee: TeeResponse;
  },
): Promise<string> {
  const data = input.tee.response?.data;
  if (!data) throw new Error("TEE response missing response.data");
  const tx = new Transaction();
  tx.setSender(signer.toSuiAddress());
  tx.moveCall({
    target: `${PACKAGE_ID}::${MODULE_NAME}::consume_prompt`,
    typeArguments: [input.coinType],
    arguments: [
      tx.object(AGENT_REGISTRY),
      tx.object(PROTOCOL_CONFIG_ID),
      tx.object(input.agentObjectId),
      tx.pure.bool(Boolean(data.success)),
      tx.pure.u64(BigInt(data.score)),
      tx.pure.vector("u8", asBytes(data.message_hash, "message_hash")),
      tx.pure.u64(BigInt(input.tee.response.timestamp)),
      tx.pure.vector("u8", asBytes(input.tee.signature, "signature")),
      tx.object(input.attackObjectId),
      tx.object(CLOCK_ID),
    ],
  });
  const executed = await execute(signer, client, tx);
  return executed.digest;
}

function readNonce(json: Record<string, unknown> | null): string | null {
  if (!json) return null;
  const nonce = json.nonce ?? json.attack_nonce;
  if (typeof nonce === "string" || typeof nonce === "number") return String(nonce);
  return null;
}

function asBytes(value: number[] | string, label: string): number[] {
  if (Array.isArray(value)) return value;
  const text = value.trim();
  if (/^(0x)?[0-9a-fA-F]+$/.test(text) && text.replace(/^0x/, "").length % 2 === 0) {
    return [...fromHex(text.startsWith("0x") ? text : `0x${text}`)];
  }
  try {
    const decoded = Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
    if (decoded.length > 0) return [...decoded];
  } catch {
    /* not base64 */
  }
  throw new Error(`${label} was not a byte array, hex, or base64 (${toHex(new Uint8Array())})`);
}
