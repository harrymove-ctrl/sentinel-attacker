import { WalrusClient } from "@mysten/walrus";
import type { Signer } from "@mysten/sui/cryptography";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { API_URL, NETWORK } from "./config.ts";
import { attackIdByNonce, authHeaders, sessionUserId } from "./api.ts";

interface Payload {
  blob_bytes: string;
  epochs: number;
}

export async function storeAttackRecord(
  signer: Signer,
  client: SuiGrpcClient,
  nonce: string,
): Promise<{ blobId: string; registerDigest: string; certifyDigest: string }> {
  const userId = await sessionUserId();
  if (!userId) {
    throw new Error(
      "Walrus storage needs REDSENTINEL_USER_ID or REDSENTINEL_COOKIE from a logged-in app.redsentinel.xyz session. The on-chain attack can still settle without it.",
    );
  }
  const attacker = signer.toSuiAddress();
  const attackId = await attackIdByNonce(nonce, attacker);
  const headers = authHeaders(userId);
  const payloadUrl = `${API_URL}/walrus/${NETWORK}/records/${attackId}/payload?attacker_address=${encodeURIComponent(attacker)}`;
  const payloadRes = await fetch(payloadUrl, { headers });
  if (!payloadRes.ok) {
    throw new Error(`Walrus payload ${payloadRes.status}: ${(await payloadRes.text()).slice(0, 400)}`);
  }
  const payload = (await payloadRes.json()) as Payload;
  const bytes = Uint8Array.from(atob(payload.blob_bytes), (char) => char.charCodeAt(0));

  const walrus = new WalrusClient({ network: "mainnet", suiClient: client });
  const encoded = await walrus.encodeBlob(bytes);
  const cost = await walrus.storageCost(bytes.length, payload.epochs);
  const wal = await client.getBalance({
    owner: attacker,
    coinType: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL",
  });
  if (BigInt(wal.balance.balance) < cost.totalCost) {
    throw new Error(
      `Need ${mist(cost.totalCost)} WAL to store the record, wallet has ${mist(BigInt(wal.balance.balance))} WAL.`,
    );
  }

  const registerTx = walrus.registerBlobTransaction({
    size: bytes.length,
    epochs: payload.epochs,
    blobId: encoded.blobId,
    rootHash: encoded.rootHash,
    deletable: false,
    owner: attacker,
  });
  registerTx.setGasPayment([]);
  const registered = await signer.signAndExecuteTransaction({
    transaction: registerTx,
    client,
  });
  if (registered.$kind === "FailedTransaction") {
    throw new Error(
      `Walrus register failed: ${registered.FailedTransaction.status.error?.message ?? "unknown"}`,
    );
  }
  await client.waitForTransaction({ digest: registered.Transaction.digest });
  const blobType = (await walrus.getBlobType()).toLowerCase();
  const created =
    registered.Transaction.effects?.changedObjects.filter(
      (object) => object.idOperation === "Created",
    ) ?? [];
  let blobObjectId: string | null = null;
  for (const object of created) {
    if (object.outputState === "DoesNotExist") continue;
    let got;
    try {
      got = await client.getObject({ objectId: object.objectId });
    } catch {
      continue;
    }
    if (got.object.type.toLowerCase() === blobType) {
      blobObjectId = object.objectId;
      break;
    }
  }
  if (!blobObjectId) throw new Error("Blob object was not created by the register transaction");

  const confirmations = await walrus.writeEncodedBlobToNodes({
    blobId: encoded.blobId,
    metadata: encoded.metadata,
    sliversByNode: encoded.sliversByNode,
    deletable: false,
    objectId: blobObjectId,
  });
  const certificate = await walrus.certificateFromConfirmations({
    confirmations,
    blobId: encoded.blobId,
    blobObjectId,
    deletable: false,
  });
  const certifyTx = walrus.certifyBlobTransaction({
    certificate,
    blobId: encoded.blobId,
    blobObjectId,
    deletable: false,
  });
  certifyTx.setGasPayment([]);
  const certified = await signer.signAndExecuteTransaction({
    transaction: certifyTx,
    client,
  });
  if (certified.$kind === "FailedTransaction") {
    throw new Error(
      `Walrus certify failed: ${certified.FailedTransaction.status.error?.message ?? "unknown"}`,
    );
  }

  const finalize = await fetch(
    `${API_URL}/walrus/${NETWORK}/records/${attackId}/finalize?attacker_address=${encodeURIComponent(attacker)}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        blob_id: encoded.blobId,
        register_digest: registered.Transaction.digest,
        certify_digest: certified.Transaction.digest,
      }),
    },
  );
  if (!finalize.ok) {
    throw new Error(`Walrus finalize ${finalize.status}: ${(await finalize.text()).slice(0, 400)}`);
  }
  return {
    blobId: encoded.blobId,
    registerDigest: registered.Transaction.digest,
    certifyDigest: certified.Transaction.digest,
  };
}

function mist(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const frac = (value % 1_000_000_000n).toString().padStart(9, "0").slice(0, 4);
  return `${whole}.${frac}`;
}
