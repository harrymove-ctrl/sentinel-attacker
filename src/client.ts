import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { decodeSuiPrivateKey, type Signer } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GRPC_URL } from "./config.ts";

export function grpcClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: "mainnet", baseUrl: GRPC_URL });
}

export function loadSigner(): Signer {
  const raw = process.env.SENTINEL_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error(
      "SENTINEL_PRIVATE_KEY is not set. Put a suiprivkey in .env on this Mac. Do not paste it into chat.",
    );
  }
  if (!raw.startsWith("suiprivkey")) {
    throw new Error("SENTINEL_PRIVATE_KEY must be a suiprivkey bech32 string.");
  }
  const { scheme } = decodeSuiPrivateKey(raw);
  if (scheme === "ED25519") return Ed25519Keypair.fromSecretKey(raw);
  if (scheme === "Secp256k1") return Secp256k1Keypair.fromSecretKey(raw);
  if (scheme === "Secp256r1") return Secp256r1Keypair.fromSecretKey(raw);
  throw new Error(`Unsupported key scheme ${scheme}`);
}
