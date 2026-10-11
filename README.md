# sentinel-attacker

Local Bun CLI for the Walrus × RedSentinel session on Sui mainnet. It signs with a key on this Mac and submits one prompt at a time. It does not write prompts.

Protocol notes: [PROTOCOL.md](PROTOCOL.md).

## Setup

```bash
bun install
cp .env.example .env
```

Put a `suiprivkey` in `.env`. Use the wallet that should receive credit. A second wallet's attacks do not count for the session. Do not paste the key into chat.

Walrus record storage also needs `REDSENTINEL_COOKIE` (the `Cookie` header from a logged-in `app.redsentinel.xyz` tab) or `REDSENTINEL_USER_ID`. The attack itself settles without that. Storage costs about 0.025 WAL. Gas is about 0.002 SUI and most of it comes back. Session defenders with fee 0 still need that gas.

## Commands

```bash
bun src/cli.ts list
bun src/cli.ts show 1266
bun src/cli.ts history walrus_support_bot
bun src/cli.ts quote 1266
bun src/cli.ts whoami
bun src/cli.ts attack --target 1205 --prompt-file ./prompt.txt
bun src/cli.ts attack --target 1205 --prompt-file ./prompt.txt --send
bun src/cli.ts walrus --nonce <nonce>
```

`attack` without `--send` quotes the fee and does not sign.

Your own defenders are refused unless you pass `--allow-own`. Self-breach points exist only Oct 19–20, and they are defender points, not attacker points.

The tool refuses a prompt you already sent to that agent, and it waits 45 seconds between sends. Do not wrap it in a tight loop.
