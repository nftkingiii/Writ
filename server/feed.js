import OpenAI from "openai";

// Real headlines from Yahoo Finance's public RSS feed, one feed per stock the vault can see.
// SERV turns each headline into a structured call; nothing here is synthetic.
const TICKERS = ["TSLA", "AMZN", "NFLX", "AMD", "PLTR"];
const PER_TICKER = 4;
const TTL_MS = 10 * 60 * 1000;
export const FEED_MODEL = process.env.SERV_FEED_MODEL || "gpt-5.4-mini";

const client = new OpenAI({ baseURL: "https://inference-api.openserv.ai/v1", apiKey: process.env.SERV_API_KEY || "missing" });

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();

async function fetchTicker(ticker) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 Writ" }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`${ticker} feed ${res.status}`);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, PER_TICKER);
  return items.map(([, body]) => {
    const get = (tag) => decode(body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] || "");
    const link = get("link");
    return {
      id: `${ticker}:${link || get("title")}`,
      feedTicker: ticker,
      title: get("title"),
      link,
      publishedAt: new Date(get("pubDate") || Date.now()).toISOString(),
      source: (() => {
        try {
          return new URL(link).hostname.replace(/^www\./, "");
        } catch {
          return "Yahoo Finance";
        }
      })(),
    };
  });
}

const callSchema = {
  type: "object",
  properties: {
    calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          ticker: { type: "string", enum: [...TICKERS, "NONE"] },
          direction: { type: "string", enum: ["bullish", "bearish", "neutral"] },
          conviction: { type: "string", enum: ["high", "medium", "low"] },
          catalyst: { type: "string", description: "The concrete catalyst named in the headline, or \"none\"." },
          thesis: { type: "string", description: "One sentence, under 140 characters, stating the trade idea and why." },
        },
        required: ["id", "ticker", "direction", "conviction", "catalyst", "thesis"],
        additionalProperties: false,
      },
    },
  },
  required: ["calls"],
  additionalProperties: false,
};

const SYSTEM = [
  "You read stock market headlines and extract the trade call each one implies, for a trading agent.",
  "Judge only from the headline text. Do not invent facts, prices, or sources.",
  "ticker: the stock the headline is mainly about among TSLA, AMZN, NFLX, AMD, PLTR; NONE if it is not about one of them.",
  "direction: bullish or bearish only when the headline states or clearly implies a directional reason; otherwise neutral.",
  "conviction: high only for a concrete, verifiable catalyst (earnings, deliveries, guidance, contracts, regulation); low for opinion, listicles, rumours or clickbait.",
  "catalyst: the concrete catalyst in a few words, or \"none\".",
  "Return one entry per input id, in the same order.",
].join("\n");

let cache = { at: 0, calls: [], errors: [] };
const theses = new Map();
let inflight = null;

async function analyse(items) {
  const todo = items.filter((i) => !theses.has(i.id));
  for (let i = 0; i < todo.length; i += 10) {
    const batch = todo.slice(i, i + 10);
    const response = await client.chat.completions.create({
      model: FEED_MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: batch.map((h) => `id: ${h.id}\nfeed: ${h.feedTicker}\nheadline: ${h.title}`).join("\n\n") },
      ],
      max_completion_tokens: 2500,
      response_format: { type: "json_schema", json_schema: { name: "calls", strict: true, schema: callSchema } },
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    for (const c of parsed.calls) theses.set(c.id, { ...c, model: response.model });
  }
}

async function refresh() {
  const results = await Promise.allSettled(TICKERS.map(fetchTicker));
  const errors = results.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message || r.reason));
  const seen = new Set();
  const items = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter((i) => i.title && !seen.has(i.title) && seen.add(i.title));
  await analyse(items);
  const calls = items
    .map((i) => ({ ...i, ...(theses.get(i.id) || {}) }))
    .filter((c) => c.ticker && c.ticker !== "NONE")
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  cache = { at: Date.now(), calls, errors };
  return cache;
}

export async function getCalls({ force = false } = {}) {
  if (!force && Date.now() - cache.at < TTL_MS && cache.calls.length) return cache;
  inflight ||= refresh().finally(() => (inflight = null));
  return inflight;
}

export const findCall = (id) => cache.calls.find((c) => c.id === id);
export const callsFor = (ticker) => cache.calls.filter((c) => c.ticker === ticker).slice(0, 3);
