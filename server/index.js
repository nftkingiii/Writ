import "dotenv/config";
import express from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { BaseError, ContractFunctionRevertedError, formatUnits, keccak256, parseUnits, stringToHex, toHex } from "viem";
import {
  DEPLOY_BLOCK,
  EXPLORER,
  FEE,
  TOKENS,
  VAULT,
  agentAccount,
  publicClient,
  symbolOf,
  vaultAbi,
  vaultState,
  walletClient,
} from "./chain.js";
import { SERV_MODEL, decide } from "./serv.js";

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || new URL("../data/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const RECORDS = `${DATA_DIR}/decisions.json`;
const VERSION = existsSync(new URL("../VERSION", import.meta.url))
  ? readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim()
  : "local";

mkdirSync(DATA_DIR, { recursive: true });
const records = existsSync(RECORDS) ? JSON.parse(readFileSync(RECORDS, "utf8")) : {};
const saveRecords = () => writeFileSync(RECORDS, JSON.stringify(records, null, 2));

// Deterministic JSON so anyone holding a record can recompute its reasoning hash.
const stable = (v) =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

function limiter(max, windowMs) {
  const hits = [];
  return (req, res, next) => {
    const now = Date.now();
    while (hits.length && hits[0] < now - windowMs) hits.shift();
    if (hits.length >= max) return res.status(429).json({ error: `Rate limited: ${max} per hour across all visitors.` });
    hits.push(now);
    next();
  };
}

function revertReason(err) {
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

const clip = (s, n = 280) => (Buffer.byteLength(s) <= n ? s : Buffer.from(s).subarray(0, n - 3).toString().replace(/�$/, "") + "...");

async function send(functionName, args, opts = {}) {
  const hash = await walletClient.writeContract({ address: VAULT, abi: vaultAbi, functionName, args, ...opts });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status, blockNumber: Number(receipt.blockNumber), url: `${EXPLORER}/tx/${hash}` };
}

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use(express.static(new URL("../public/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")));

app.get("/api/health", async (_req, res) => {
  try {
    const chainId = await publicClient.getChainId();
    res.json({ ok: true, version: VERSION, chainId, vault: VAULT, agent: agentAccount?.address, model: SERV_MODEL, serv: Boolean(process.env.SERV_API_KEY) });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/config", (_req, res) => res.json({ vault: VAULT, tokens: TOKENS, explorer: EXPLORER, chainId: 46630, model: SERV_MODEL }));

app.get("/api/state", async (_req, res) => {
  try {
    res.json(await vaultState());
  } catch (e) {
    res.status(502).json({ error: `Could not read the vault: ${e.shortMessage || e.message}` });
  }
});

app.post("/api/decide", limiter(30, 3600_000), async (req, res) => {
  const signal = String(req.body?.signal || "").trim().slice(0, 1200);
  if (!signal) return res.status(400).json({ error: "Write a market signal for the agent to act on." });
  if (!process.env.SERV_API_KEY) return res.status(503).json({ error: "SERV is not configured on this server." });

  const state = await vaultState();
  if (state.paused) return res.status(409).json({ error: "The owner has paused the vault. The agent cannot act." });

  let d;
  try {
    d = await decide(state, signal);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }

  const decisionId = keccak256(toHex(randomBytes(32)));
  const record = {
    decisionId,
    createdAt: new Date().toISOString(),
    mandateVersion: state.mandateVersion,
    mandate: state.mandate,
    signal,
    vaultSnapshot: state.holdings,
    serv: { model: d.model, id: d.servId, usage: d.usage, finishReason: d.finishReason, latencyMs: d.latencyMs },
    prompt: d.prompt,
    output: d.output,
  };
  const reasoningHash = keccak256(stringToHex(stable(record)));
  const o = d.output;
  let outcome;

  try {
    if (o.action === "swap") {
      const amountIn = parseUnits(o.amountIn, 18);
      const base = [decisionId, BigInt(state.mandateVersion), reasoningHash, TOKENS[o.tokenIn], TOKENS[o.tokenOut], FEE, amountIn];
      let quoted;
      try {
        const sim = await publicClient.simulateContract({
          account: agentAccount,
          address: VAULT,
          abi: vaultAbi,
          functionName: "execute",
          args: [...base, 0n, clip(o.rationale)],
        });
        quoted = sim.result;
      } catch (e) {
        // SERV proposed a trade the vault would reject. Record that on-chain as a refusal instead of spending gas on a revert.
        const reason = revertReason(e);
        const tx = await send("refuse", [decisionId, BigInt(state.mandateVersion), reasoningHash, clip(`Vault would reject ${reason}. SERV said: ${o.rationale}`)]);
        outcome = { kind: "blocked", reason, tx };
      }
      if (!outcome) {
        const minOut = (quoted * 97n) / 100n;
        const tx = await send("execute", [...base, minOut, clip(o.rationale)]);
        outcome = { kind: "executed", quotedOut: formatUnits(quoted, 18), minOut: formatUnits(minOut, 18), tx };
      }
    } else {
      const tx = await send("refuse", [decisionId, BigInt(state.mandateVersion), reasoningHash, clip(o.rationale)]);
      outcome = { kind: "refused", tx };
    }
  } catch (e) {
    outcome = { kind: "error", reason: revertReason(e) };
  }

  records[decisionId] = { ...record, reasoningHash, outcome };
  saveRecords();
  res.json({ decisionId, reasoningHash, output: o, serv: record.serv, outcome });
});

// Demonstrates the second lock: submit a trade that skips SERV entirely and let the vault revert it on-chain.
// Only trades the vault would reject are accepted, so this can never execute a trade without a SERV decision.
app.post("/api/probe", limiter(10, 3600_000), async (req, res) => {
  const { tokenIn, tokenOut, amountIn } = req.body || {};
  if (!TOKENS[tokenIn] || !TOKENS[tokenOut] || !/^\d+(\.\d{1,18})?$/.test(String(amountIn))) {
    return res.status(400).json({ error: "Pick two tokens and an amount." });
  }
  const state = await vaultState();
  const args = [keccak256(toHex(randomBytes(32))), BigInt(state.mandateVersion), keccak256(stringToHex("probe")), TOKENS[tokenIn], TOKENS[tokenOut], FEE, parseUnits(String(amountIn), 18), 0n, "probe: no SERV decision"];
  try {
    await publicClient.simulateContract({ account: agentAccount, address: VAULT, abi: vaultAbi, functionName: "execute", args });
    return res.status(400).json({ error: "That trade is inside the vault's limits. Probes only demonstrate trades the vault blocks; real trades need a SERV decision." });
  } catch (e) {
    const expected = revertReason(e);
    try {
      const tx = await send("execute", args, { gas: 400_000n });
      res.json({ expected, tx });
    } catch (e2) {
      res.json({ expected, error: revertReason(e2) });
    }
  }
});

app.get("/api/decisions", async (_req, res) => {
  try {
    const [executed, refused] = await Promise.all(
      ["Executed", "Refused"].map((eventName) =>
        publicClient.getContractEvents({ address: VAULT, abi: vaultAbi, eventName, fromBlock: DEPLOY_BLOCK }),
      ),
    );
    const rows = [...executed, ...refused].map((l) => {
      const a = l.args;
      const rec = records[a.decisionId];
      return {
        kind: l.eventName === "Executed" ? "executed" : rec?.outcome?.kind === "blocked" ? "blocked" : "refused",
        decisionId: a.decisionId,
        mandateVersion: Number(a.mandateVersion),
        reasoningHash: a.reasoningHash,
        hashMatches: rec ? rec.reasoningHash === a.reasoningHash : null,
        tokenIn: a.tokenIn && symbolOf(a.tokenIn),
        tokenOut: a.tokenOut && symbolOf(a.tokenOut),
        amountIn: a.amountIn != null ? formatUnits(a.amountIn, 18) : null,
        amountOut: a.amountOut != null ? formatUnits(a.amountOut, 18) : null,
        rationale: a.rationale,
        signal: rec?.signal ?? null,
        clauses: rec?.output?.clauses ?? null,
        blockNumber: Number(l.blockNumber),
        tx: l.transactionHash,
        url: `${EXPLORER}/tx/${l.transactionHash}`,
      };
    });
    rows.sort((x, y) => y.blockNumber - x.blockNumber);
    res.json(rows);
  } catch (e) {
    res.status(502).json({ error: `Could not read vault events: ${e.shortMessage || e.message}` });
  }
});

app.get("/api/decisions/:id", (req, res) => {
  const rec = records[req.params.id];
  if (!rec) return res.status(404).json({ error: "No reasoning record on this server for that decision." });
  const { reasoningHash, outcome, ...hashed } = rec;
  res.json({ ...rec, recomputedHash: keccak256(stringToHex(stable(hashed))) });
});

app.listen(PORT, () => console.log(`Writ on :${PORT} vault=${VAULT} agent=${agentAccount?.address} model=${SERV_MODEL}`));
