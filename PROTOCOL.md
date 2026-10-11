# RedSentinel Sui attack protocol

Captured 2026-10-11 from `app.redsentinel.xyz` network calls and the live frontend bundle. Not guessed.

## Addresses (Sui mainnet)

The published docs still list package `0x88b83f36…`. The app, for agents that have a `coin_type`, uses:

| Name | Value |
| --- | --- |
| Package | `0x7cede7184475cf56fa3d33539d3ce2d3d31699d09cecc8d076d6ac1564d480c0` |
| Module | `sentinel` |
| Agent registry | `0x97eb779b9e1ee51325ef893222e1898db4a21d69f56df5d2b106844c631c6eb8` |
| Protocol config | `0x5f269e2d7fcec66de43bad716578b48bd6f748a6df790ddf73576bd1a036ca98` |
| Clock | `0x6` |
| Random | `0x8` |
| Indexer | `https://api.redsentinel.xyz` |
| App API | `https://app.redsentinel.xyz` |
| Fullnode | `https://fullnode.mainnet.sui.io:443` (gRPC) |

Enclave URL in the bundle is `http://18.213.79.225:3000`. The browser does not call it. It posts to the Next route, which proxies.

## Read APIs

```
GET /agents/mainnet?limit=20&offset=0&sortBy=total_balance&sortDirection=desc&chain=sui&status=active&tag=
GET /agents/mainnet/details?agent_path={path}
GET /agents/mainnet/{agent_id}/chat
GET /auth/session
```

Attack page route: `/attack/{agent_path}`.

`get_effective_cost<Coin>(agent, protocol_config)` is a simulate call. Return value is a little-endian u64. Verified 2026-10-11: agents 1266 and 1205 both return `0`, even though the indexer lists 0.134 SUI for 1205. The page fee is the indexer number. The signed transaction uses the chain quote. These session defenders have on-chain `cost_per_message: 0`.

## Signed attack

1. `request_attack<Coin>(registry, agent, protocol_config, coin, 0x8, 0x6)`
   - SUI payment is `splitCoins(gas, [fee])`, including fee `0`.
   - The ticket is transferred to the sender. `Attack.nonce` is the HTTP `attack_id`, not the object id.
   - Gas is about 0.002 SUI, mostly refunded. The attack fee itself is separate and is 0 on the session defenders.
2. `POST https://app.redsentinel.xyz/api/consume-prompt`

```json
{ "agent_id": "1266", "message": "...", "attack_id": "<nonce>", "attacker": "0x..." }
```

`chain` is optional and defaults to Sui. Required Sui fields confirmed by 400/422 responses: `agent_id`, `message`, `attack_id`, `attacker`.

Response used on-chain:

```
response.data.success
response.data.score
response.data.message_hash
response.timestamp          # passed as u64, not multiplied
signature                   # hex or byte array
response.data.agent_response
response.data.jury_response
```

3. `consume_prompt<Coin>(registry, protocol_config, agent, success, score, message_hash, timestamp, signature, attack_ticket, 0x6)`

The third argument is the agent object. The ninth is the Attack ticket. Confirmed from the call site `L(agent_object_id, agent, tee, ticket_object_id)`.

Win condition in the docs: `success == true` and `score >= 70`. The contract pays the pool when the TEE signature verifies and the verdict is a success.

## Walrus record

After settlement the app does:

```
GET /api/sentinels/attack-by-nonce?network=sui-mainnet&nonce={nonce}&attacker_address={sender}
GET https://api.redsentinel.xyz/walrus/mainnet/records/{attack_id}/payload?attacker_address={sender}
```

Payload is `{ blob_bytes: base64, epochs }`. The client then:

1. `encodeBlob`
2. `registerBlobTransaction` (this is the wallet-signed `system::reserve_space` + `register_blob`, about 0.025 WAL)
3. `writeEncodedBlobToNodes`
4. `certifyBlobTransaction`
5. `POST /walrus/mainnet/records/{attack_id}/finalize` with `{ blob_id, register_digest, certify_digest }`

Steps 1–5 need a logged-in RedSentinel user (`x-user-id`, from `GET /auth/session`). The on-chain attack does not.

## Session rules that the CLI enforces

From the Walrus session page, not from the chain:

- Attacks count for the signing wallet. Extra wallets do not count.
- Identical prompts do not count.
- Self-breach scores defender points only, and only during Oct 19–20.
- Bursts can disqualify. The CLI sends one prompt per invocation and waits 45s between sends.
