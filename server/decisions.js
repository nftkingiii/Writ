import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BaseError, ContractFunctionRevertedError, decodeEventLog, formatUnits, keccak256, parseUnits, stringToHex, toHex } from "viem";
import { EXPLORER, FEE, TOKENS, VAULT, agentAccount, publicClient, symbolOf, vaultAbi, vaultState, walletClient } from "./chain.js";
import { decide } from "./serv.js";

const DATA_DIR = process.env.DATA_DIR || new URL("../data/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const RECORDS = `${DATA_DIR}/decisions.json`;
mkdirSync(DATA_DIR, { recursive: true });
// A fresh deployment volume starts with the reasoning records of decisions already made on this vault.
const SEED = new URL("../seed/decisions.json", import.meta.url);
if (!existsSync(RECORDS) && existsSync(SEED)) copyFileSync(SEED, RECORDS);
export const records = existsSync(RECORDS) ? JSON.parse(readFileSync(RECORDS, "utf8")) : {};
const saveRecords = () => writeFileSync(RECORDS, JSON.stringify(records, null, 2));

// Deterministic JSON so anyone holding a record can recompute its reasoning hash.
export const stable = (v) =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

export function revertReason(err) {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r?.data?.errorName) {
      const args = (r.data.args || []).map((a) => (typeof a === "bigint" ? (a > 10n ** 12n ? formatUnits(a, 18) : a.toString()) : String(a)));
      return `${r.data.errorName}(${args.map((a) => symbolOf(a)).join(", ")})`;
    }
    return err.shortMessage;
  }
  return String(err?.message || err);
}

export const clip = (s, n = 280) =>
  Buffer.byteLength(s) <= n ? s : Buffer.from(s).subarray(0, n - 3).toString().replace(/�$/, "") + "...";

export async function send(functionName, args, opts = {}) {
  const hash = await walletClient.writeContract({ address: VAULT, abi: vaultAbi, functionName, args, ...opts });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status, blockNumber: Number(receipt.blockNumber), url: `${EXPLORER}/tx/${hash}`, logs: receipt.logs };
}

function executedAmountOut(logs) {
  for (const l of logs) {
    try {
      const ev = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Executed") return ev.args.amountOut;
    } catch {}
  }
  return null;
}

/** One decision: SERV reasons over the onchain mandate, then the agent records a trade or a refusal on the vault. */
export async function runDecision(signal, meta = {}) {
  const state = await vaultState();
  if (state.paused) return { status: 409, body: { error: "The owner has paused the vault. The agent cannot act." } };

  let d;
  try {
    d = await decide(state, signal);
  } catch (e) {
    return { status: 502, body: { error: String(e.message || e) } };
  }

  const decisionId = keccak256(toHex(randomBytes(32)));
  const record = {
    decisionId,
    createdAt: new Date().toISOString(),
    kind: meta.kind || "signal",
    call: meta.call || null,
    mandateVersion: state.mandateVersion,
    mandate: state.mandate,
    signal,
    vaultSnapshot: state.holdings,
    serv: { model: d.model, id: d.servId, usage: d.usage, finishReason: d.finishReason, latencyMs: d.latencyMs, guarded: Boolean(d.guarded) },
    prompt: d.prompt,
    output: d.output,
  };
  const reasoningHash = keccak256(stringToHex(stable(record)));
  const o = d.output;
  const version = BigInt(state.mandateVersion);
  let outcome;

  try {
    if (o.action === "swap") {
      const amountIn = parseUnits(o.amountIn, 18);
      const base = [decisionId, version, reasoningHash, TOKENS[o.tokenIn], TOKENS[o.tokenOut], FEE, amountIn];
      let quoted;
      try {
        const sim = await publicClient.simulateContract({ account: agentAccount, address: VAULT, abi: vaultAbi, functionName: "execute", args: [...base, 0n, clip(o.rationale)] });
        quoted = sim.result;
      } catch (e) {
        // SERV proposed a trade the vault would reject. Record that on-chain as a refusal instead of spending gas on a revert.
        const reason = revertReason(e);
        const tx = await send("refuse", [decisionId, version, reasoningHash, clip(`Vault would reject ${reason}. SERV said: ${o.rationale}`)]);
        outcome = { kind: "blocked", reason, tx };
      }
      if (!outcome) {
        const minOut = (quoted * 97n) / 100n;
        const tx = await send("execute", [...base, minOut, clip(o.rationale)]);
        const out = executedAmountOut(tx.logs) ?? quoted;
        outcome = { kind: "executed", amountIn: o.amountIn, amountOut: formatUnits(out, 18), quotedOut: formatUnits(quoted, 18), minOut: formatUnits(minOut, 18), tx };
      }
    } else {
      const tx = await send("refuse", [decisionId, version, reasoningHash, clip(o.rationale)]);
      outcome = { kind: "refused", tx };
    }
  } catch (e) {
    outcome = { kind: "error", reason: revertReason(e) };
  }
  if (outcome.tx) delete outcome.tx.logs;

  records[decisionId] = { ...record, reasoningHash, outcome };
  saveRecords();
  return { status: 200, body: { decisionId, reasoningHash, output: o, serv: record.serv, outcome, call: record.call } };
}

/** Open positions = stock balances held by the vault, with entry thesis and average entry price from executed buys. */
export async function positions() {
  const state = await vaultState();
  const byTicker = {};
  for (const r of Object.values(records).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (r.outcome?.kind !== "executed") continue;
    const { tokenIn, tokenOut } = r.output;
    if (tokenIn === "WETH" && tokenOut !== "WETH") {
      const p = (byTicker[tokenOut] ||= { cost: 0, qty: 0, entries: [] });
      p.cost += Number(r.outcome.amountIn);
      p.qty += Number(r.outcome.amountOut);
      p.entries.push({ decisionId: r.decisionId, at: r.createdAt, thesis: r.call?.thesis || r.signal, title: r.call?.title || null, tx: r.outcome.tx?.url });
    } else if (tokenOut === "WETH" && byTicker[tokenIn]) {
      const p = byTicker[tokenIn];
      const sold = Number(r.outcome.amountIn);
      const frac = p.qty > 0 ? Math.min(1, sold / p.qty) : 1;
      p.cost -= p.cost * frac;
      p.qty = Math.max(0, p.qty - sold);
    }
  }
  const held = state.holdings.filter((h) => h.symbol !== "WETH" && Number(h.balance) > 0);
  return {
    cash: state.holdings.find((h) => h.symbol === "WETH"),
    mandateVersion: state.mandateVersion,
    positions: held.map((h) => {
      const p = byTicker[h.symbol];
      const entryPrice = p && p.qty > 0 ? p.cost / p.qty : null;
      return {
        ticker: h.symbol,
        balance: h.balance,
        priceWeth: h.priceWeth,
        valueWeth: h.priceWeth == null ? null : Number(h.balance) * h.priceWeth,
        entryPriceWeth: entryPrice,
        changePct: entryPrice && h.priceWeth ? ((h.priceWeth - entryPrice) / entryPrice) * 100 : null,
        origin: !(p && p.qty > 0) ? "deposit" : Number(h.balance) > p.qty * 1.000001 ? "mixed" : "agent",
        agentQty: p ? p.qty : 0,
        entries: p?.entries.slice(-3) || [],
        maxIn: h.maxIn,
        allowed: h.allowed,
      };
    }),
  };
}
