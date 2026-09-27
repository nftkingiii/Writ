import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const artifact = JSON.parse(readFileSync(new URL("./WritVault.json", import.meta.url)));
export const vaultAbi = artifact.abi;
export const vaultBytecode = artifact.bytecode;

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export const EXPLORER = robinhoodTestnet.blockExplorers.default.url;
export const ROUTER = "0x3Ce954107b1A675826B33bF23060Dd655e3758fE";
export const FACTORY = "0x911b4000d3422f482f4062a913885f7b035382df";
export const FEE = 3000;

// Canonical Robinhood Stock Tokens on testnet (verified Stock beacon proxies from the same deployer),
// plus the WETH used by the Uniswap v3 router.
export const TOKENS = {
  WETH: "0x33e4191705c386532ba27cBF171Db86919200B94",
  TSLA: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
  AMZN: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02",
  NFLX: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93",
  AMD: "0x71178BAc73cBeb415514eB542a8995b82669778d",
  PLTR: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0",
};
export const SYMBOLS = Object.keys(TOKENS);
export const symbolOf = (addr) =>
  SYMBOLS.find((s) => TOKENS[s].toLowerCase() === String(addr).toLowerCase()) || addr;

const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)",
  "function token0() view returns (address)",
]);

export const publicClient = createPublicClient({ chain: robinhoodTestnet, transport: http() });

export const agentAccount = process.env.AGENT_PRIVATE_KEY
  ? privateKeyToAccount(process.env.AGENT_PRIVATE_KEY)
  : null;

export const walletClient = agentAccount
  ? createWalletClient({ account: agentAccount, chain: robinhoodTestnet, transport: http() })
  : null;

export const VAULT = process.env.VAULT_ADDRESS;
export const DEPLOY_BLOCK = BigInt(process.env.VAULT_DEPLOY_BLOCK || "0");

const poolCache = new Map();
async function poolFor(token) {
  if (poolCache.has(token)) return poolCache.get(token);
  const pool = await publicClient.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "getPool",
    args: [TOKENS.WETH, token, FEE],
  });
  const token0 = await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "token0" });
  const entry = { pool, wethIsToken0: token0.toLowerCase() === TOKENS.WETH.toLowerCase() };
  poolCache.set(token, entry);
  return entry;
}

/** Spot price of one token in WETH, read from the Uniswap v3 0.3% pool (both sides 18 decimals). */
export async function priceInWeth(symbol) {
  if (symbol === "WETH") return 1;
  const { pool, wethIsToken0 } = await poolFor(TOKENS[symbol]);
  const [sqrtPriceX96] = await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "slot0" });
  const p = Number(sqrtPriceX96) / 2 ** 96;
  const token1PerToken0 = p * p;
  return wethIsToken0 ? 1 / token1PerToken0 : token1PerToken0;
}

const read = (functionName, args = []) =>
  publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName, args });

export async function vaultState() {
  const [owner, agent, paused, mandate, mandateVersion, maxTradesPerDay, tradesToday, currentDay, assets] =
    await Promise.all([
      read("owner"),
      read("agent"),
      read("paused"),
      read("mandate"),
      read("mandateVersion"),
      read("maxTradesPerDay"),
      read("tradesToday"),
      read("currentDay"),
      read("assetList"),
    ]);
  const today = BigInt(Math.floor(Date.now() / 1000 / 86400));
  const holdings = await Promise.all(
    SYMBOLS.map(async (symbol) => {
      const token = TOKENS[symbol];
      const [balance, limit, price] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] }),
        read("limits", [token]),
        priceInWeth(symbol).catch(() => null),
      ]);
      return {
        symbol,
        address: token,
        balance: formatUnits(balance, 18),
        allowed: limit[0],
        maxIn: formatUnits(limit[1], 18),
        priceWeth: price,
      };
    }),
  );
  const agentEth = agentAccount ? formatUnits(await publicClient.getBalance({ address: agentAccount.address }), 18) : null;
  return {
    vault: VAULT,
    owner,
    agent,
    agentEth,
    paused,
    mandate,
    mandateVersion: Number(mandateVersion),
    maxTradesPerDay: Number(maxTradesPerDay),
    tradesToday: currentDay === today ? Number(tradesToday) : 0,
    listedAssets: assets.map(symbolOf),
    holdings,
  };
}
