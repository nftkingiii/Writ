import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  parseEther,
  parseAbi,
} from "https://esm.sh/viem@2.21.0";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "");
const fmt = (n, d = 4) => (n == null ? "–" : Number(n) === 0 ? "0" : Number(n) < 0.0001 ? Number(n).toExponential(2) : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const TICK_COLORS = { WETH: "#5d5767", TSLA: "#a3393a", AMZN: "#9a5d17", NFLX: "#7a2230", AMD: "#2f5d7d", PLTR: "#222" };
const TICK_NAMES = { WETH: "Wrapped Ether", TSLA: "Tesla", AMZN: "Amazon", NFLX: "Netflix", AMD: "AMD", PLTR: "Palantir" };

let config = null;
let state = null;
let account = null;

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- tabs ----------
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", on);
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  }
  if (tab.id === "tab-ledger") loadLedger();
  if (tab.id === "tab-mandate") loadState();
  history.replaceState(null, "", `#${tab.id.slice(4)}`);
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d) { const n = tabs[(i + d + tabs.length) % tabs.length]; n.focus(); selectTab(n); }
  });
});

// ---------- state ----------
function tick(sym) {
  return `<span class="tick"><b style="background:${TICK_COLORS[sym] || "#5d5767"}">${esc(sym)}</b><span>${esc(sym)}<small>${esc(TICK_NAMES[sym] || "")}</small></span></span>`;
}

async function loadState() {
  try {
    state = await api("/api/state");
  } catch (e) {
    $("#mandate-text").textContent = e.message;
    return;
  }
  $("#mandate-text").textContent = state.mandate;
  $("#mandate-version").textContent = `v${state.mandateVersion}`;
  $("#seal-version").textContent = `v${state.mandateVersion}`;
  if (!$("#mandate-edit").value) $("#mandate-edit").value = state.mandate;
  $("#vault-link").textContent = short(state.vault);
  $("#vault-link").href = `${config.explorer}/address/${state.vault}`;
  $("#book").innerHTML = state.holdings
    .map(
      (h) => `<tr class="${h.allowed ? "" : "off"}"><td>${tick(h.symbol)}</td><td class="num">${fmt(h.balance)}</td>
      <td class="num">${h.allowed ? fmt(h.maxIn) : "Not allowed"}</td><td class="num">${h.priceWeth == null ? "–" : fmt(h.priceWeth, 6)}</td></tr>`,
    )
    .join("");
  $("#facts").innerHTML = [
    ["Trades today", `${state.tradesToday} of ${state.maxTradesPerDay}`],
    ["Agent", state.paused ? "Paused by owner" : "Active"],
    ["Agent gas", state.agentEth == null ? "–" : `${fmt(state.agentEth, 5)} ETH`],
    ["Owner", short(state.owner)],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`)
    .join("");
  $("#pause-label").textContent = state.paused ? "Agent is paused. It cannot trade or refuse." : "Agent is active.";
  $("#pause-btn").textContent = state.paused ? "Resume agent" : "Pause agent";
  const isOwner = account && state.owner.toLowerCase() === account.toLowerCase();
  document.querySelectorAll(".owner-only").forEach((el) => (el.hidden = !isOwner));
  $("#visitor-note").hidden = isOwner;
  $("#visitor-note").textContent = account && !isOwner
    ? `Connected wallet ${short(account)} is not the vault owner, so owner controls stay hidden.`
    : "Owner controls appear when the vault owner's wallet is connected.";
}

// ---------- agent ----------
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { $("#signal").value = c.dataset.signal; $("#signal").focus(); }));

const STEPS = ["Reading mandate and vault from Robinhood Chain", "SERV reasoning (Kronos, Shadow Agent)", "Recording the decision onchain"];
function pending(i) {
  $("#verdict").innerHTML = `<h2>Working</h2><div class="pending" style="margin-top:16px">${STEPS.map(
    (s, j) => `<div class="step ${j < i ? "done" : j === i ? "on" : ""}"><i></i>${s}</div>`,
  ).join("")}</div>`;
}

function renderVerdict(r) {
  const o = r.output;
  const kind = r.outcome.kind;
  const label = { executed: "Executed", refused: "Refused by SERV", blocked: "Blocked by vault", error: "Not recorded" }[kind];
  const trade = o.action === "swap" ? `${esc(o.amountIn)} ${esc(o.tokenIn)} → ${esc(o.tokenOut)}` : "No trade";
  const tx = r.outcome.tx;
  $("#verdict").innerHTML = `
    <div class="v-head"><div><h2>Decision</h2><div class="v-trade">${trade}</div></div><span class="stamp ${kind}">${label}</span></div>
    <p class="v-rationale">${esc(o.rationale)}</p>
    ${o.clauses?.length ? `<div class="clauses">${o.clauses.map((c) => `<span class="clause">Clause ${esc(String(c).replace(/^clause\s*/i, ""))}</span>`).join("")}</div>` : ""}
    ${kind === "blocked" ? `<p class="err">SERV proposed a trade, but the vault would reject it: <code>${esc(r.outcome.reason)}</code>. The agent recorded a refusal instead.</p>` : ""}
    ${kind === "error" ? `<p class="err">${esc(r.outcome.reason)}</p>` : ""}
    <dl class="proof">
      ${kind === "executed" ? `<dt>Received</dt><dd>${fmt(r.outcome.quotedOut, 6)} ${esc(o.tokenOut)} quoted, min ${fmt(r.outcome.minOut, 6)}</dd>` : ""}
      ${tx ? `<dt>Transaction</dt><dd><a href="${tx.url}" target="_blank" rel="noopener">${short(tx.hash)}</a> · ${tx.status === "success" ? "confirmed" : esc(tx.status)}</dd>` : ""}
      <dt>Reasoning hash</dt><dd class="mono"><a href="/api/decisions/${r.decisionId}" target="_blank" rel="noopener">${short(r.reasoningHash)}</a></dd>
      <dt>SERV</dt><dd>${esc(r.serv.model)} · ${(r.serv.latencyMs / 1000).toFixed(1)}s${r.serv.usage ? ` · ${r.serv.usage.total_tokens} tokens` : ""}</dd>
    </dl>`;
}

$("#signal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#decide");
  btn.disabled = true;
  pending(0);
  const t1 = setTimeout(() => pending(1), 900);
  const t2 = setTimeout(() => pending(2), 16000);
  try {
    const r = await api("/api/decide", { signal: $("#signal").value });
    renderVerdict(r);
  } catch (err) {
    $("#verdict").innerHTML = `<h2>Decision</h2><p class="err" style="margin-top:14px">${esc(err.message)}</p>`;
  } finally {
    clearTimeout(t1); clearTimeout(t2);
    btn.disabled = false;
  }
});

// ---------- probe ----------
$("#probe-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#probe");
  btn.disabled = true;
  $("#probe-result").innerHTML = `<div class="step on"><i></i>Submitting without a SERV decision…</div>`;
  try {
    const r = await api("/api/probe", { tokenIn: $("#probe-in").value, tokenOut: $("#probe-out").value, amountIn: $("#probe-amt").value });
    $("#probe-result").innerHTML = r.tx
      ? `<p><span class="stamp reverted">Reverted onchain</span></p><p class="sub">The vault rejected it with <code>${esc(r.expected)}</code>. <a href="${r.tx.url}" target="_blank" rel="noopener">See the failed transaction</a>.</p>`
      : `<p class="err">Vault rejects with <code>${esc(r.expected)}</code>. ${esc(r.error || "")}</p>`;
  } catch (err) {
    $("#probe-result").innerHTML = `<p class="err">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- ledger ----------
async function loadLedger() {
  $("#ledger").innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
  let rows;
  try {
    rows = await api("/api/decisions");
  } catch (e) {
    $("#ledger").innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  if (!rows.length) {
    $("#ledger").innerHTML = `<div class="card"><p class="sub">No decisions yet. Ask the agent from the Agent tab and the first one will appear here.</p></div>`;
    return;
  }
  const label = { executed: "Executed", refused: "Refused", blocked: "Blocked" };
  $("#ledger").innerHTML = rows
    .map(
      (r) => `<article class="card entry">
      <div class="when"><span class="stamp ${r.kind}">${label[r.kind]}</span><span>Block ${r.blockNumber}</span><span>Mandate v${r.mandateVersion}</span></div>
      <div>
        <div class="what">${r.kind === "executed" ? `${fmt(r.amountIn, 6)} ${esc(r.tokenIn)} → ${fmt(r.amountOut, 6)} ${esc(r.tokenOut)}` : "No trade"}</div>
        <p class="why">${esc(r.rationale)}</p>
        ${r.signal ? `<div class="sig">Signal: “${esc(r.signal)}”</div>` : ""}
      </div>
      <div class="links">
        <a href="${r.url}" target="_blank" rel="noopener">Transaction</a>
        ${r.hashMatches == null ? `<span class="match">record not on this server</span>` : `<a href="/api/decisions/${r.decisionId}" target="_blank" rel="noopener">Reasoning record</a><span class="match ${r.hashMatches ? "yes" : "no"}">${r.hashMatches ? "hash matches chain" : "hash mismatch"}</span>`}
      </div></article>`,
    )
    .join("");
}
$("#ledger-refresh").addEventListener("click", loadLedger);

// ---------- wallet ----------
const chain = {
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" } },
};
const vaultAbi = parseAbi(["function setMandate(string)", "function setPaused(bool)"]);
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)"]);
const pub = createPublicClient({ chain, transport: http() });
let wallet = null;

function walletLabel() {
  const b = $("#wallet");
  if (!account) { b.textContent = "Connect wallet"; b.classList.remove("wrong"); return; }
  b.innerHTML = `<span class="dot"></span>${short(account)}`;
}

async function ensureChain() {
  const id = await window.ethereum.request({ method: "eth_chainId" });
  if (parseInt(id, 16) === chain.id) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xb626" }] });
  } catch (e) {
    // Wallets disagree on the "unknown chain" error code (4902, -32603, nested data), so any failure other
    // than a user rejection falls through to adding the chain, which also switches to it in most wallets.
    if (e.code === 4001) throw e;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: "0xb626", chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: [chain.blockExplorers.default.url] }],
    });
    const now = await window.ethereum.request({ method: "eth_chainId" });
    if (parseInt(now, 16) !== chain.id) {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xb626" }] });
    }
  }
}

$("#wallet").addEventListener("click", async () => {
  if (!window.ethereum) { alert("No browser wallet found. Install MetaMask or Rabby to use owner controls."); return; }
  try {
    [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
    wallet = createWalletClient({ account, chain, transport: custom(window.ethereum) });
    walletLabel();
    try {
      await ensureChain();
    } catch (e) {
      $("#owner-result").innerHTML = `<p class="err">Could not switch to Robinhood Chain Testnet: ${esc(e.shortMessage || e.message)}</p>`;
    }
    await loadState();
  } catch (e) {
    alert(e.shortMessage || e.message);
  }
});
window.ethereum?.on?.("accountsChanged", (a) => { account = a[0] || null; walletLabel(); loadState(); });

async function ownerTx(label, fn) {
  const out = $("#owner-result");
  out.innerHTML = `<div class="step on"><i></i>${esc(label)}: confirm in your wallet…</div>`;
  try {
    await ensureChain();
    const hash = await fn();
    out.innerHTML = `<div class="step on"><i></i>${esc(label)}: waiting for Robinhood Chain…</div>`;
    const rc = await pub.waitForTransactionReceipt({ hash });
    out.innerHTML = rc.status === "success"
      ? `<p class="ok-note">${esc(label)} confirmed. <a href="${chain.blockExplorers.default.url}/tx/${hash}" target="_blank" rel="noopener">View transaction</a></p>`
      : `<p class="err">${esc(label)} reverted. <a href="${chain.blockExplorers.default.url}/tx/${hash}" target="_blank" rel="noopener">View transaction</a></p>`;
    await loadState();
  } catch (e) {
    out.innerHTML = `<p class="err">${e.code === 4001 || /rejected/i.test(e.message) ? `${esc(label)} was rejected in the wallet.` : esc(e.shortMessage || e.message)}</p>`;
  }
}

$("#mandate-save").addEventListener("click", () =>
  ownerTx("Publish mandate", () => wallet.writeContract({ address: config.vault, abi: vaultAbi, functionName: "setMandate", args: [$("#mandate-edit").value.trim()] })),
);
$("#pause-btn").addEventListener("click", () =>
  ownerTx(state?.paused ? "Resume agent" : "Pause agent", () => wallet.writeContract({ address: config.vault, abi: vaultAbi, functionName: "setPaused", args: [!state.paused] })),
);
$("#fund-eth-btn").addEventListener("click", () =>
  ownerTx("Deposit ETH", () => wallet.sendTransaction({ to: config.vault, value: parseEther($("#fund-eth").value) })),
);
$("#fund-tsla-btn").addEventListener("click", () =>
  ownerTx("Deposit TSLA", () => wallet.writeContract({ address: config.tokens.TSLA, abi: erc20, functionName: "transfer", args: [config.vault, parseEther($("#fund-tsla").value)] })),
);

// ---------- boot ----------
(async () => {
  config = await api("/api/config");
  const opts = Object.keys(config.tokens).map((s) => `<option>${s}</option>`).join("");
  $("#probe-in").innerHTML = opts;
  $("#probe-out").innerHTML = opts;
  $("#probe-in").value = "WETH";
  $("#probe-out").value = "TSLA";
  const want = document.getElementById(`tab-${location.hash.slice(1)}`);
  if (want) selectTab(want);
  loadState();
})();
