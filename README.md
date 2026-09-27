# Writ

**Copy the call, not the risk.**

Writ is a call terminal with a trading agent that can only act within its *writ*. It reads real market headlines, uses **SERV Reasoning** to turn each one into a structured call, and lets you enter any call in one click. Whether the agent actually trades is decided by an owner-written mandate stored on **Robinhood Chain**, and a vault contract enforces hard limits no matter what the reasoning concludes. Every outcome, including every refusal, is written onchain with a hash of the full SERV reasoning record.

Built for the SERV Hackathon, Edition 01 (Mainnet & MCP track: agents that act on Robinhood Chain).

## How it works

```
Yahoo Finance headlines ──► SERV (gpt-5.4-mini, strict JSON) ──► call: ticker, direction, conviction, catalyst, thesis
                                                                        │ "Enter within writ"
                                                                        ▼
            WritVault.mandate (onchain) ──► SERV (Kronos + Shadow Agent + prompt guard) ──► swap | refuse
                                                                        │
                           preflight simulate ─── would revert? ──► refuse() onchain with the vault's reason
                                                                        │
                                                                        ▼
                         WritVault.execute(): mandate version, asset allowlist, per-trade cap, daily cap, replay, pause
                                                                        │
                                                        Uniswap v3 on Robinhood Chain (stock token ⇄ WETH)
```

Two locks, independently:

1. **SERV** decides against the mandate. The mandate is authoritative; headline text and signals are treated as untrusted input and cannot change the rules. `serv_prompt_guard`, `serv_shadow_agent` (validate-and-revise) and the `-serv-kronos` model suffix (audited reasoning prompt) are all on.
2. **The vault** enforces what the owner set onchain: a decision must name the current mandate version, both assets must be allowed, the amount must be within the per-trade cap, the daily trade count must not be exceeded, a decision ID can only be used once, and the owner can pause the agent. The **"Try to go around SERV"** panel sends a trade with no SERV decision straight to the vault so you can watch it revert onchain.

The agent keeps managing positions: **Review with agent** re-reads the entry thesis, the price since entry and the latest headlines for that stock, and SERV decides to exit (a real sell) or hold (a recorded refusal) under the same mandate.

## Live proof (Robinhood Chain Testnet, chain 46630)

| What | Link |
|---|---|
| WritVault (verified source) | [0xd95f4b6cbf4a99fcfee9ccd95be6fea685d23870](https://explorer.testnet.chain.robinhood.com/address/0xd95f4b6cbf4a99fcfee9ccd95be6fea685d23870) |
| Owner deposit, ETH wrapped to WETH (from the app) | [0x26a9…0b18](https://explorer.testnet.chain.robinhood.com/tx/0x26a90770f89fc07148897aa442090fcefc3ba0330ad9210bceedc07562a00b18) |
| Owner deposit, 2 TSLA (from the app) | [0xa0f1…be47](https://explorer.testnet.chain.robinhood.com/tx/0xa0f12cab740c16179fdd2c49d511ca9d5b8fdb88ac948796ebdeac8f129ebe47) |
| First SERV decision: TSLA call refused under mandate v1 | [0x665b…3cce](https://explorer.testnet.chain.robinhood.com/tx/0x665bb3351e513734a5a9126955054f5c08c5b9c3e7a5cbce4519a63b09163cce) |

The Ledger tab reads every `Executed` and `Refused` event from the vault and shows whether the server's reasoning record re-hashes to the value stored onchain.

## What is real and what is not

- **Real:** headlines (Yahoo Finance RSS), SERV calls and decisions, Robinhood Chain testnet transactions, Robinhood Stock Token testnet contracts (TSLA, AMZN, NFLX, AMD, PLTR), Uniswap v3 pools on the testnet.
- **Testnet:** all assets are testnet tokens and pool prices are testnet pool prices, which do not track the real share price. Nothing here is investment advice.
- **Not built:** Robinhood's brokerage MCP (agentic accounts are US brokerage products); social/X feeds (no paid API access, and Writ does not show synthetic posts).

## Contracts and addresses

| | Address |
|---|---|
| WritVault | `0xd95f4b6cbf4a99fcfee9ccd95be6fea685d23870` |
| Agent (signer) | `0x22AEDE1feb7658c8371F24102f9dB2DAE6564cC6` |
| Uniswap v3 SwapRouter02 | `0x3Ce954107b1A675826B33bF23060Dd655e3758fE` |
| Uniswap v3 factory | `0x911b4000d3422f482f4062a913885f7b035382df` |
| WETH | `0x33e4191705c386532ba27cBF171Db86919200B94` |
| TSLA / AMZN | `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` / `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02` |

## Run it

Requirements: Node 20+, Foundry (for the contract tests).

```bash
npm ci
cp .env.example .env   # then fill AGENT_PRIVATE_KEY, SERV_API_KEY, VAULT_ADDRESS, VAULT_DEPLOY_BLOCK
npm start              # http://localhost:8080
```

Contract tests run against the live testnet pools:

```bash
cd contracts && forge test --fork-url https://rpc.testnet.chain.robinhood.com
```

Deploy your own vault (the agent key deploys; the address you pass becomes the owner):

```bash
node server/deploy.js 0xYourOwnerAddress
```

## Layout

- `contracts/src/WritVault.sol` — the mandate-bound vault
- `contracts/test/WritVault.t.sol` — fork tests: in-mandate swap, over-limit, disallowed asset, stale mandate, replay, daily cap, non-agent, pause, refusal, withdraw
- `server/feed.js` — headlines to SERV calls
- `server/serv.js` — the SERV decision (Kronos, Shadow Agent, prompt guard, strict schema)
- `server/decisions.js` — preflight, execute or refuse onchain, reasoning records, positions
- `public/` — the Calls, Positions, Mandate and Ledger interface

## License

MIT
