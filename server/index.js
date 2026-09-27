import "dotenv/config";
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { formatUnits, keccak256, parseUnits, stringToHex, toHex } from "viem";
import { DEPLOY_BLOCK, EXPLORER, FEE, TOKENS, VAULT, agentAccount, publicClient, symbolOf, vaultAbi, vaultState } from "./chain.js";
import { SERV_MODEL } from "./serv.js";
import { FEED_MODEL, callsFor, findCall, getCalls } from "./feed.js";
import { positions, records, revertReason, runDecision, send, stable } from "./decisions.js";

const PORT = process.env.PORT || 8080;
const VERSION = existsSync(new URL("../VERSION", import.meta.url))
  ? readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim()
  : "local";

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

const servReady = (res) => {
  if (process.env.SERV_API_KEY) return true;
  res.status(503).json({ error: "SERV is not configured on this server." });
  return false;
};

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use(express.static(new URL("../public/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")));

app.get("/api/health", async (_req, res) => {
  try {
    const chainId = await publicClient.getChainId();
    res.json({ ok: true, version: VERSION, chainId, vault: VAULT, agent: agentAccount?.address, model: SERV_MODEL, feedModel: FEED_MODEL, serv: Boolean(process.env.SERV_API_KEY) });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/config", (_req, res) => res.json({ vault: VAULT, tokens: TOKENS, explorer: EXPLORER, chainId: 46630, model: SERV_MODEL, feedModel: FEED_MODEL }));

app.get("/api/state", async (_req, res) => {
  try {
    res.json(await vaultState());
  } catch (e) {
    res.status(502).json({ error: `Could not read the vault: ${e.shortMessage || e.message}` });
  }
});

// ---- calls: real headlines turned into structured calls by SERV ----

app.get("/api/calls", async (req, res) => {
  try {
    const { at, calls, errors } = await getCalls({ force: req.query.refresh === "1" });
    res.json({ updatedAt: new Date(at).toISOString(), model: FEED_MODEL, calls, errors });
  } catch (e) {
    res.status(502).json({ error: `Could not load calls: ${e.message}` });
  }
});

app.post("/api/calls/enter", limiter(30, 3600_000), async (req, res) => {
  if (!servReady(res)) return;
  const call = findCall(String(req.body?.id || ""));
  if (!call) return res.status(404).json({ error: "That call is no longer in the feed. Refresh and pick another." });
  const signal = [
    `CALL to enter, from a public headline (${call.source}, ${call.publishedAt}):`,
    `"${call.title}"`,
    `Extracted call: ${call.direction} on ${call.ticker}, ${call.conviction} conviction, catalyst: ${call.catalyst}.`,
    `Thesis: ${call.thesis}`,
    "Decide whether the mandate permits entering this call now.",
  ].join("\n");
  const r = await runDecision(signal, {
    kind: "enter",
    call: { id: call.id, ticker: call.ticker, title: call.title, link: call.link, direction: call.direction, conviction: call.conviction, thesis: call.thesis },
  });
  res.status(r.status).json(r.body);
});

// ---- free-form signal ----

app.post("/api/decide", limiter(30, 3600_000), async (req, res) => {
  const signal = String(req.body?.signal || "").trim().slice(0, 1200);
  if (!signal) return res.status(400).json({ error: "Write a market signal for the agent to act on." });
  if (!servReady(res)) return;
  const r = await runDecision(signal);
  res.status(r.status).json(r.body);
});

// ---- positions the agent keeps managing ----

app.get("/api/positions", async (_req, res) => {
  try {
    res.json(await positions());
  } catch (e) {
    res.status(502).json({ error: `Could not read positions: ${e.shortMessage || e.message}` });
  }
});

app.post("/api/positions/review", limiter(30, 3600_000), async (req, res) => {
  if (!servReady(res)) return;
  const ticker = String(req.body?.ticker || "");
  const book = await positions();
  const pos = book.positions.find((p) => p.ticker === ticker);
  if (!pos) return res.status(404).json({ error: `The vault holds no ${ticker}.` });
  await getCalls().catch(() => null);
  const latest = callsFor(ticker);
  const signal = [
    `POSITION REVIEW for ${ticker}. The vault holds ${pos.balance} ${ticker}.`,
    pos.entryPriceWeth
      ? `Average entry ${pos.entryPriceWeth.toPrecision(6)} WETH, now ${pos.priceWeth?.toPrecision(6)} WETH (${pos.changePct >= 0 ? "+" : ""}${pos.changePct.toFixed(2)}% since entry).`
      : `This position came from an owner deposit, not an agent entry. Current price ${pos.priceWeth?.toPrecision(6)} WETH.`,
    pos.entries.length ? `Entry thesis: ${pos.entries.at(-1).thesis}` : "No recorded entry thesis.",
    latest.length
      ? `Latest ${ticker} headlines with extracted calls:\n${latest.map((c) => `- "${c.title}" -> ${c.direction}, ${c.conviction} conviction, catalyst: ${c.catalyst}`).join("\n")}`
      : `No recent ${ticker} headlines.`,
    "Decide whether the mandate requires exiting (swap this stock into WETH) or holding (refuse, and say why the position stays open).",
  ].join("\n");
  const r = await runDecision(signal, { kind: "review", call: { ticker } });
  res.status(r.status).json(r.body);
});

// ---- the second lock: a trade with no SERV decision, reverted by the vault on-chain ----
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
      delete tx.logs;
      res.json({ expected, tx });
    } catch (e2) {
      res.json({ expected, error: revertReason(e2) });
    }
  }
});

// ---- ledger read from chain ----

app.get("/api/decisions", async (_req, res) => {
  try {
    const [executed, refused] = await Promise.all(
      ["Executed", "Refused"].map((eventName) => publicClient.getContractEvents({ address: VAULT, abi: vaultAbi, eventName, fromBlock: DEPLOY_BLOCK })),
    );
    const rows = [...executed, ...refused].map((l) => {
      const a = l.args;
      const rec = records[a.decisionId];
      return {
        kind: l.eventName === "Executed" ? "executed" : rec?.outcome?.kind === "blocked" ? "blocked" : "refused",
        source: rec?.kind || null,
        decisionId: a.decisionId,
        mandateVersion: Number(a.mandateVersion),
        reasoningHash: a.reasoningHash,
        hashMatches: rec ? rec.reasoningHash === a.reasoningHash : null,
        tokenIn: a.tokenIn && symbolOf(a.tokenIn),
        tokenOut: a.tokenOut && symbolOf(a.tokenOut),
        amountIn: a.amountIn != null ? formatUnits(a.amountIn, 18) : null,
        amountOut: a.amountOut != null ? formatUnits(a.amountOut, 18) : null,
        rationale: a.rationale,
        call: rec?.call ?? null,
        signal: rec?.kind === "signal" ? rec.signal : null,
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

app.listen(PORT, () => {
  console.log(`Writ on :${PORT} vault=${VAULT} agent=${agentAccount?.address} model=${SERV_MODEL}`);
  if (process.env.SERV_API_KEY) {
    getCalls()
      .then((c) => console.log(`calls ready: ${c.calls.length}`))
      .catch((e) => console.log(`calls warmup failed: ${e.message}`));
  }
});
