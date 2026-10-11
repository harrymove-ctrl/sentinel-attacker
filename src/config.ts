export const API_URL = "https://api.redsentinel.xyz";
export const APP_URL = "https://app.redsentinel.xyz";
export const NETWORK = "mainnet";

/** Live mainnet package from the app bundle, 2026-10-11. Docs still list the older package. */
export const PACKAGE_ID =
  "0x7cede7184475cf56fa3d33539d3ce2d3d31699d09cecc8d076d6ac1564d480c0";
export const MODULE_NAME = "sentinel";
export const AGENT_REGISTRY =
  "0x97eb779b9e1ee51325ef893222e1898db4a21d69f56df5d2b106844c631c6eb8";
export const PROTOCOL_CONFIG_ID =
  "0x5f269e2d7fcec66de43bad716578b48bd6f748a6df790ddf73576bd1a036ca98";
export const CLOCK_ID = "0x6";
export const RANDOM_ID = "0x8";
export const SUI_COIN_TYPE = "0x2::sui::SUI";

export const GRPC_URL =
  process.env.SUI_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443";

/** Session fair-play floor. Repeated identical prompts do not count, and bursts can disqualify. */
export const MIN_INTERVAL_MS = 45_000;
export const MAX_PROMPT_CHARS = 3_500;

export const SELF_BREACH_START = Date.parse("2026-10-19T00:00:00Z");
export const SELF_BREACH_END = Date.parse("2026-10-21T00:00:00Z");
