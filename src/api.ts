import { API_URL, APP_URL, NETWORK } from "./config.ts";

export interface AgentSummary {
  agent_id: string;
  agent_name: string;
  creator: string;
  cost_per_message: string;
  current_cost_per_message: string;
  total_balance: string;
  agent_object_id: string;
  model_name: string;
  model_provider: string;
  state: string;
  total_attacks: number;
  agent_path: string;
  coin_type: string;
  chain: string;
  winner: string | null;
}

export interface AgentDetails extends AgentSummary {
  prompt: string;
  attack_goal: string;
  participants_count: number;
  deployment_tx_hash: string;
}

export interface ChatMessage {
  type: string;
  id: string;
  timestamp: string;
  sender: string;
  content: string;
  agent_response: string;
  score: string;
  success: boolean;
  tx_digest: string;
  amount_sent: string;
  walrus_blob_id: string | null;
  attack_id: string;
  message_hash: number[] | null;
}

interface ListResponse {
  agents: AgentSummary[];
  total?: number;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

export async function listAgents(options: {
  limit?: number;
  offset?: number;
  chain?: string;
  status?: string;
  tag?: string;
  sortBy?: string;
  sortDirection?: "asc" | "desc";
}): Promise<{ agents: AgentSummary[]; total: number }> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 20),
    offset: String(options.offset ?? 0),
    sortBy: options.sortBy ?? "total_balance",
    sortDirection: options.sortDirection ?? "desc",
  });
  if (options.chain) params.set("chain", options.chain);
  if (options.status && options.status !== "all") params.set("status", options.status);
  if (options.tag) params.set("tag", options.tag);
  const body = await getJson<ListResponse>(
    `${API_URL}/agents/${NETWORK}?${params}`,
  );
  return { agents: body.agents, total: body.total ?? body.agents.length };
}

export async function findAgent(target: string): Promise<AgentDetails> {
  const trimmed = target.trim();
  if (/^\d+$/.test(trimmed)) {
    let offset = 0;
    const limit = 50;
    for (;;) {
      const page = await listAgents({ limit, offset, chain: "sui", status: "all" });
      const hit = page.agents.find((agent) => agent.agent_id === trimmed);
      if (hit) return agentDetails(hit.agent_path);
      if (offset + page.agents.length >= page.total || page.agents.length === 0) break;
      offset += page.agents.length;
    }
    throw new Error(`No Sui mainnet agent with id ${trimmed}`);
  }
  return agentDetails(trimmed);
}

export async function agentDetails(agentPath: string): Promise<AgentDetails> {
  return getJson<AgentDetails>(
    `${API_URL}/agents/${NETWORK}/details?agent_path=${encodeURIComponent(agentPath)}`,
  );
}

export async function chatHistory(agentId: string): Promise<ChatMessage[]> {
  const body = await getJson<{ messages: ChatMessage[]; total: number }>(
    `${API_URL}/agents/${NETWORK}/${agentId}/chat`,
  );
  return body.messages ?? [];
}

export interface TeeResponse {
  signature: string;
  response: {
    intent: number | string;
    timestamp: number | string;
    data: {
      success: boolean;
      score: number | string;
      message_hash: number[] | string;
      agent_response?: string;
      fun_response?: string;
      jury_response?: string;
      agent_id?: string | number;
    };
  };
}

export async function consumePrompt(input: {
  agentId: string;
  message: string;
  attackNonce: string;
  attacker: string;
}): Promise<TeeResponse> {
  const res = await fetch(`${APP_URL}/api/consume-prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: input.agentId,
      message: input.message,
      attack_id: input.attackNonce,
      attacker: input.attacker,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`consume-prompt ${res.status}: ${text.slice(0, 800)}`);
  return JSON.parse(text) as TeeResponse;
}

export async function attackIdByNonce(nonce: string, attacker: string): Promise<string> {
  const params = new URLSearchParams({
    network: `sui-${NETWORK}`,
    nonce,
    attacker_address: attacker,
  });
  const body = await getJson<{ attack_id: string }>(
    `${APP_URL}/api/sentinels/attack-by-nonce?${params}`,
  );
  if (!body.attack_id) throw new Error("attack-by-nonce returned no attack_id");
  return body.attack_id;
}

export async function sessionUserId(): Promise<string | null> {
  const explicit = process.env.REDSENTINEL_USER_ID?.trim();
  if (explicit) return explicit;
  const cookie = process.env.REDSENTINEL_COOKIE?.trim();
  if (!cookie) return null;
  const res = await fetch(`${API_URL}/auth/session`, { headers: { cookie } });
  if (!res.ok) return null;
  const body = (await res.json()) as { user?: { id?: string } | null };
  return body.user?.id ?? null;
}

export function authHeaders(userId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-user-id": userId,
  };
  const cookie = process.env.REDSENTINEL_COOKIE?.trim();
  if (cookie) headers.cookie = cookie;
  return headers;
}
