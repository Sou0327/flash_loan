import { ethers } from "ethers";
import { z } from 'zod';
import { startMetricsServer, updateMetrics } from './metrics';
import * as dotenv from "dotenv";
import { getConfig, getNetworkConfig, getContractsConfig, getBorrowAmounts, getProfitSettings, isForkedEnvironment } from './config';
import { DynamicGasManager } from './gas-manager';
import { getCacheManager } from './cache-manager';
import { FlashbotsManager } from './flashbots-manager';

// 型エイリアス（可読性とバグ防止）
type Wei = bigint;
type USD = number;
type Gwei = number;
type Percentage = number;

// Node.js環境でfetchを利用可能にする（Node18+では不要）
if (typeof fetch === 'undefined') {
  const nodeFetch = require('node-fetch');
  globalThis.fetch = nodeFetch;
}

dotenv.config();

// プライベートキーの検証（厳格）
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY || PRIVATE_KEY.length !== 66) {
  console.error("❌ PRIVATE_KEY is required and must be 66 characters (0x + 64 hex)");
  process.exit(1);
}

// プロバイダーとウォレットの設定
const RPC_URL = process.env.MAINNET_RPC || process.env.ALCHEMY_WSS?.replace('wss://', 'https://');
const FLASHBOTS_RPC = process.env.FLASHBOTS_RPC || "https://rpc.flashbots.net";
const USE_FLASHBOTS = process.env.USE_FLASHBOTS === "true";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const flashbotsProvider = USE_FLASHBOTS ? new ethers.JsonRpcProvider(FLASHBOTS_RPC) : null;
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const flashbotsWallet = flashbotsProvider ? new ethers.Wallet(PRIVATE_KEY, flashbotsProvider) : null;

// フォーク環境の検出（より厳密に）
const IS_FORK_ENVIRONMENT = (RPC_URL?.includes('127.0.0.1') || 
                           RPC_URL?.includes('localhost')) && 
                           !RPC_URL?.includes('alchemy.com');
const NETWORK_NAME = IS_FORK_ENVIRONMENT ? "FORK" : "MAINNET";

// コントラクトアドレス
const BALANCER_FLASH_ARB = process.env.BALANCER_FLASH_ARB || "0xB96DfBa8688C6e30D4F9057572C3d451C8cCD598";
const USDC = process.env.USDC || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = process.env.WETH || "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAI = process.env.DAI || "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const USDT = process.env.USDT || "0xdAC17F958D2ee523a2206206994597C13D831ec7";

// ミームコイン
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"; // WBTC

// ABI
const abi = [
  "function executeFlashLoan(address[] tokens, uint256[] amounts, uint256 minProfitBps, bytes userData) external",
  "function owner() view returns (address)",
  "function withdraw(address token) external"
];

const flashArb = new ethers.Contract(BALANCER_FLASH_ARB, abi, wallet);

// 最適化された設定
const CONFIG = {
  // 借入額設定（現実的な額）
  AMOUNTS: {
    USDC: ethers.parseUnits("50000", 6),   // 5万 USDC（増額）
    DAI: ethers.parseUnits("50000", 18),   // 5万 DAI（増額）
    WETH: ethers.parseUnits("15", 18),     // 15 WETH（増額）
    WBTC: ethers.parseUnits("1.5", 8),     // 1.5 WBTC（増額）
  },
  
  // ガス設定（現実的な値）
  GAS: {
    LIMIT: BigInt(400000),        // 実測値に基づく
    MAX_PRICE_GWEI: 30,           // より積極的に（25→30 Gwei）
    PRIORITY_FEE_GWEI: 1.5,       // MEV保護用の優先料金
  },
  
  // 利益設定（より積極的）
  PROFIT: {
    MIN_PERCENTAGE: 0.15,     // 0.15%（より積極的）
    MIN_AMOUNT_USD: 50,       // $50以上（下げて機会増加）
    GAS_MULTIPLIER: 1.8,      // ガス代の1.8倍（リスク許容度上げ）
  },
  
  // 実行制御
  EXECUTION: {
    CHECK_INTERVAL_BLOCKS: 3, // 3ブロックごとにチェック
    MAX_SLIPPAGE: 1,          // 最大スリッページ 1%
  },
  
  MONITORING: {
    BLOCK_INTERVAL: 8,        // 8ブロックごとにスキャン（約2分間隔、API負荷軽減）
    MAX_SLIPPAGE_PERCENT: 0.5, // 最大スリッページ
  }
};

// 積極性レベル設定（環境変数で調整可能）
const AGGRESSIVENESS_LEVEL = parseInt(process.env.AGGRESSIVENESS_LEVEL || "2"); // 1=保守的, 2=バランス, 3=積極的

// 積極性に応じた設定調整
function getAggresiveConfig() {
  const baseConfig = CONFIG;
  
  switch (AGGRESSIVENESS_LEVEL) {
    case 1: // 保守的
      return {
        ...baseConfig,
        MONITORING: { ...baseConfig.MONITORING, BLOCK_INTERVAL: 15 }, // 10→15に延長
        PROFIT: { ...baseConfig.PROFIT, MIN_PERCENTAGE: 0.2, GAS_MULTIPLIER: 2.5 }
      };
    case 3: // 積極的
      return {
        ...baseConfig,
        MONITORING: { ...baseConfig.MONITORING, BLOCK_INTERVAL: 6 }, // 3→6に延長
        PROFIT: { ...baseConfig.PROFIT, MIN_PERCENTAGE: 0.12, GAS_MULTIPLIER: 1.5 },
        GAS: { ...baseConfig.GAS, MAX_PRICE_GWEI: 40 }
      };
    default: // バランス（デフォルト）
      return baseConfig;
  }
}

const ACTIVE_CONFIG = getAggresiveConfig();

// 📊 リスク管理設定
const RISK_LIMITS = {
  MAX_DAILY_LOSS_USD: 1000,        // 日次最大損失 $1000
  MAX_HOURLY_LOSS_USD: 200,        // 時間最大損失 $200  
  MIN_SUCCESS_RATE: 0.3,           // 最低成功率 30%
  MAX_PRICE_DEVIATION: 0.05,       // 最大価格乖離 5%
  MIN_LIQUIDITY_USD: 100000,       // 最小流動性要件 $100k
  MAX_SLIPPAGE_BPS: 200,           // 最大スリッページ 2%
  COOLDOWN_AFTER_LOSS_MS: 300000,  // 損失後のクールダウン 5分
};

// 📈 リスク追跡状態
const RISK_STATE = {
  dailyLoss: 0,
  hourlyLoss: 0,
  lastLossTime: 0,
  recentTransactions: [] as Array<{
    timestamp: number;
    profit: number;
    success: boolean;
  }>,
  consecutiveFailures: 0,
};

// 🔄 1時間ごとのリセット
setInterval(() => {
  RISK_STATE.hourlyLoss = 0;
  console.log('📊 Hourly loss counter reset');
}, 3600000); // 1時間

// 🔄 24時間ごとのリセット  
setInterval(() => {
  RISK_STATE.dailyLoss = 0;
  console.log('📊 Daily loss counter reset');
}, 86400000); // 24時間

// 実行状態管理（シンプル化）
const STATE = {
  totalProfit: 0,
  totalTransactions: 0,
  successfulTransactions: 0,
  lastBlockNumber: 0,
  startTime: Date.now(),
  gasHistory: [] as Array<{ gasUsedUSD: bigint; timestamp: number; blockNumber: number }>,
  avgGasUSD: 0,
};

// ガス履歴の管理
const GAS_HISTORY_SIZE = 20; // 過去20件の平均を使用
let lastResetTime = Date.now(); // 最後のリセット時刻

function updateGasHistory(gasUsedWei: bigint, gasPriceWei: bigint, ethPriceUSD: number, blockNumber: number) {
  // 24時間ごとにガス履歴をリセット（メモリ肥大対策）
  const now = Date.now();
  if (now - lastResetTime > 24 * 60 * 60 * 1000) { // 24時間
    STATE.gasHistory.length = 0;
    lastResetTime = now;
    console.log("📊 Gas history reset (24h cleanup)");
  }
  
  // BigIntで安全に計算（桁あふれ対策）
  const ethPriceScaled = BigInt(Math.round(ethPriceUSD * 1e8)); // 8桁精度
  const gasUsedUSDScaled = (gasUsedWei * gasPriceWei * ethPriceScaled) / (BigInt(1e18) * BigInt(1e8));
  
  STATE.gasHistory.push({
    gasUsedUSD: gasUsedUSDScaled,
    timestamp: Date.now(),
    blockNumber
  });
  
  // 履歴サイズを制限
  if (STATE.gasHistory.length > GAS_HISTORY_SIZE) {
    STATE.gasHistory.shift();
  }
  
  // 平均ガス代を更新（シンプルなBigInt→Number変換）
  const totalGasUSD = STATE.gasHistory.reduce((sum, entry) => sum + entry.gasUsedUSD, BigInt(0));
  const avgGasUSDScaled = totalGasUSD / BigInt(STATE.gasHistory.length);
  STATE.avgGasUSD = Number(avgGasUSDScaled) / 1e18; // 直接変換（オーバーフロー範囲外）
  
  const gasUsedUSDNumber = Number(gasUsedUSDScaled) / 1e18;
  console.log(`⛽ Gas used: $${gasUsedUSDNumber.toFixed(2)} | Avg: $${STATE.avgGasUSD.toFixed(2)}`);
}

// 設定（旧設定を削除）
const IS_TEST_MODE = IS_FORK_ENVIRONMENT; // フォーク環境では自動的にテストモード

// フォーク環境用の設定
const FORK_CONFIG = {
  // フォーク環境では小額でテスト
  AMOUNTS: {
    USDC: ethers.parseUnits("1000", 6),   // 1000 USDC
    DAI: ethers.parseUnits("1000", 18),   // 1000 DAI
    WETH: ethers.parseUnits("0.5", 18),   // 0.5 WETH
    WBTC: ethers.parseUnits("0.02", 8),   // 0.02 WBTC
  },
  PROFIT: {
    MIN_PERCENTAGE: 0.1,      // 0.1%（テスト用に低く設定）
    MIN_AMOUNT_USD: 1,        // $1以上
    GAS_MULTIPLIER: 1.5,      // フォーク環境では低めに設定
  }
};

// 自動引き出し設定
const AUTO_WITHDRAW_THRESHOLD = parseFloat(process.env.AUTO_WITHDRAW_THRESHOLD || "1000"); // $1000
const AUTO_WITHDRAW_TOKEN = process.env.AUTO_WITHDRAW_TOKEN || USDC; // デフォルトはUSDC
const AUTO_WITHDRAW_ENABLED = process.env.AUTO_WITHDRAW_ENABLED === "true";

// 0x Protocol API設定
const apiKey = process.env.ZX_API_KEY!; // 0x APIキー
const chainId = "1";

// API プロバイダーの型定義
interface ApiProvider {
  name: string;
  baseUrl: string;
  headers: Record<string, string>;
  buildPriceUrl: (params: URLSearchParams) => string;
  buildQuoteUrl: (params: URLSearchParams) => string;
  rateLimitHeaders: {
    remaining: string;
    reset: string;
  };
}

// API フェイルオーバー設定
const API_PROVIDERS: ApiProvider[] = [
  {
    name: "0x",
    baseUrl: "https://api.0x.org/swap/permit2",
    headers: { 
      '0x-api-key': apiKey,
      '0x-version': 'v2'
    },
    buildPriceUrl: (params: URLSearchParams) => {
      return `https://api.0x.org/swap/permit2/price?${params.toString()}`;
    },
    buildQuoteUrl: (params: URLSearchParams) => {
      return `https://api.0x.org/swap/permit2/quote?${params.toString()}`;
    },
    rateLimitHeaders: {
      remaining: 'x-ratelimit-remaining',
      reset: 'x-ratelimit-reset'
    }
  }
];

let currentProviderIndex = 0;
const rateLimitState = new Map<string, { resetTime: number; remaining: number }>();
const MAX_RATE_LIMIT_ENTRIES = 10; // 最大10プロバイダーまで

// Rate-limit対応のfetch
async function fetchWithRateLimit(url: string, options: any, retries = 3): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const provider = API_PROVIDERS[currentProviderIndex];
      
      // Rate limit状態をチェック
      const rateLimitKey = provider.name;
      const rateLimit = rateLimitState.get(rateLimitKey);
      
      if (rateLimit && Date.now() < rateLimit.resetTime && rateLimit.remaining <= 10) { // 5→10に変更
        const waitTime = Math.min(rateLimit.resetTime - Date.now(), 15000); // 10秒→15秒に延長
        if (waitTime > 0) {
          console.log(`⏳ Rate limited by ${provider.name}, waiting ${waitTime}ms`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }

      // API呼び出し間隔を調整（連続呼び出し防止）
      await new Promise(resolve => setTimeout(resolve, 300)); // 100ms→300msに延長

      const response = await fetch(url, options);
      
      // Rate limit情報を更新
      const remainingHeader = provider.rateLimitHeaders.remaining;
      const resetHeader = provider.rateLimitHeaders.reset;
      
      const remaining = Number(response.headers.get(remainingHeader) ?? '100');
      const resetTime = Number(response.headers.get(resetHeader) ?? '0') * 1000;
      
      const safeRemaining = isNaN(remaining) ? 100 : remaining;
      const safeResetTime = isNaN(resetTime) ? Date.now() + 60000 : resetTime;
      
      rateLimitState.set(rateLimitKey, { resetTime: safeResetTime, remaining: safeRemaining });
      
      if (response.ok) {
        return response;
      }
      
      // 429 (Rate Limited) の場合は次のプロバイダーに切り替え
      if (response.status === 429) {
        console.log(`⚠️  Rate limited (429), switching provider`);
        currentProviderIndex = (currentProviderIndex + 1) % API_PROVIDERS.length;
        await new Promise(resolve => setTimeout(resolve, 3000)); // 2秒→3秒に延長
        continue;
      }
      
      // その他のエラーの場合はリトライ
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // 1秒→2秒に延長
        continue;
      }
      
      return response;
      
    } catch (error) {
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // 1秒→2秒に延長
        continue;
      }
      throw error;
    }
  }
  
  throw new Error(`All API providers failed after ${retries} retries`);
}

// Zodスキーマ定義（0x APIレスポンス検証）
const ZxPriceSchema = z.object({
  buyAmount: z.union([z.string(), z.number()]).transform(v => String(v)),
  sellAmount: z.union([z.string(), z.number()]).transform(v => String(v)),
  price: z.string().optional(),
  guaranteedPrice: z.string().optional(),
});

const ZxQuoteSchema = z.object({
  data: z.string(),
  to: z.string(),
  allowanceTarget: z.string(),
  estimatedGas: z.union([z.string(), z.number()]).transform(v => String(v)).optional(),
  buyAmount: z.union([z.string(), z.number()]).transform(v => String(v)),
  sellAmount: z.union([z.string(), z.number()]).transform(v => String(v)),
});

type ZxPriceResponse = z.infer<typeof ZxPriceSchema>;
type ZxQuoteResponse = z.infer<typeof ZxQuoteSchema>;

// アービトラージパスの定義
interface ArbPath {
  name: string;
  borrowToken: string;
  borrowAmount: bigint;
  borrowDecimals: number;
  targetToken: string;
  targetDecimals: number;
}

// 動的にアービトラージパスを生成（ログ簡潔化）
function getArbPaths(): ArbPath[] {
  const amounts = IS_FORK_ENVIRONMENT ? FORK_CONFIG.AMOUNTS : CONFIG.AMOUNTS;
  
  return [
    // 高流動性ペア（現実的な機会）
  {
    name: "USDC -> WETH -> USDC",
    borrowToken: USDC,
      borrowAmount: amounts.USDC,
    borrowDecimals: 6,
    targetToken: WETH,
    targetDecimals: 18
  },
    {
      name: "USDC -> WBTC -> USDC",
      borrowToken: USDC,
      borrowAmount: amounts.USDC,
      borrowDecimals: 6,
      targetToken: WBTC,
      targetDecimals: 8
    },
    {
      name: "USDC -> DAI -> USDC",
      borrowToken: USDC,
      borrowAmount: amounts.USDC,
      borrowDecimals: 6,
      targetToken: DAI,
      targetDecimals: 18
    },
    {
      name: "USDC -> USDT -> USDC",
      borrowToken: USDC,
      borrowAmount: amounts.USDC,
      borrowDecimals: 6,
      targetToken: USDT,
      targetDecimals: 6
    },
  {
    name: "DAI -> WETH -> DAI",
    borrowToken: DAI,
      borrowAmount: amounts.DAI,
    borrowDecimals: 18,
    targetToken: WETH,
    targetDecimals: 18
    },
    {
      name: "DAI -> WBTC -> DAI",
      borrowToken: DAI,
      borrowAmount: amounts.DAI,
      borrowDecimals: 18,
      targetToken: WBTC,
      targetDecimals: 8
    },
    {
      name: "DAI -> USDC -> DAI",
      borrowToken: DAI,
      borrowAmount: amounts.DAI,
      borrowDecimals: 18,
      targetToken: USDC,
      targetDecimals: 6
    },
    {
      name: "WETH -> USDC -> WETH",
      borrowToken: WETH,
      borrowAmount: amounts.WETH,
      borrowDecimals: 18,
      targetToken: USDC,
      targetDecimals: 6
    },
    {
      name: "WETH -> DAI -> WETH",
      borrowToken: WETH,
      borrowAmount: amounts.WETH,
      borrowDecimals: 18,
      targetToken: DAI,
      targetDecimals: 18
    },
    {
      name: "WETH -> WBTC -> WETH",
      borrowToken: WETH,
      borrowAmount: amounts.WETH,
      borrowDecimals: 18,
      targetToken: WBTC,
      targetDecimals: 8
    }
  ];
}

// 価格キャッシュの実装
const priceCache = new Map<string, { price: number; timestamp: number }>();
const CACHE_TTL = 60000; // 1分

// キャッシュ付き価格取得関数
async function getTokenPriceUSDCached(tokenAddress: string): Promise<number> {
  const cacheKey = tokenAddress.toLowerCase();
  const cached = priceCache.get(cacheKey);
  
  // キャッシュが有効な場合は使用
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.price;
  }
  
  // 新しい価格を取得
  const price = await getTokenPriceUSD(tokenAddress);
  
  // キャッシュに保存
  priceCache.set(cacheKey, {
    price,
    timestamp: Date.now()
  });
  
  return price;
}

// ETH価格専用キャッシュ
let ethPriceCache: { price: number; timestamp: number } | null = null;

async function getETHPriceUSDCached(): Promise<number> {
  // キャッシュが有効な場合は使用
  if (ethPriceCache && (Date.now() - ethPriceCache.timestamp) < CACHE_TTL) {
    return ethPriceCache.price;
  }
  
  // 新しい価格を取得
  const price = await getETHPriceUSD();
  
  // キャッシュに保存
  ethPriceCache = {
    price,
    timestamp: Date.now()
  };
  
  return price;
}

// 価格フィード関数（動的取得）
async function getTokenPriceUSD(tokenAddress: string): Promise<number> {
  try {
    const response = await fetch(
      `https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${tokenAddress}&buyToken=${USDC}&sellAmount=1000000000000000000`,
      {
        headers: {
          '0x-api-key': apiKey,
          '0x-version': 'v2'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as any;
    const usdcAmount = Number(data.buyAmount) / 1e6; // USDC has 6 decimals
    return usdcAmount; // 1 token = X USDC
  } catch (error) {
    console.warn(`⚠️  Failed to get price for ${tokenAddress}:`, error instanceof Error ? error.message : String(error));
    
    // フォールバック価格マッピング
    const priceMap: { [key: string]: number } = {
      [USDC.toLowerCase()]: 1.0,
      [DAI.toLowerCase()]: 1.0,
      [USDT.toLowerCase()]: 1.0,
      [WETH.toLowerCase()]: 3000,
      [WBTC.toLowerCase()]: 60000,
    };
    
    const normalizedAddress = tokenAddress.toLowerCase();
    return priceMap[normalizedAddress] || 1.0;
  }
}

// ETH/USD価格を取得する専用関数
async function getETHPriceUSD(): Promise<number> {
  try {
    const response = await fetch(
      `https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${WETH}&buyToken=${USDC}&sellAmount=1000000000000000000`,
      {
        headers: {
          '0x-api-key': apiKey,
          '0x-version': 'v2'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as any;
    const usdcAmount = Number(data.buyAmount) / 1e6; // USDC has 6 decimals
    return usdcAmount; // 通常の価格形式で返す（例：3000.00）
  } catch (error) {
    console.warn(`⚠️  Failed to get ETH price:`, error instanceof Error ? error.message : String(error));
    return 3000; // フォールバック: $3000（通常の価格形式）
  }
}

// スリッページチェック関数
function checkSlippage(
  borrowAmount: bigint,
  returnAmount: bigint,
  maxSlippagePercent: number = CONFIG.EXECUTION.MAX_SLIPPAGE
): boolean {
  // 返却額が借入額より多いほど正の値（利益）
  const slippagePct = (Number(returnAmount) - Number(borrowAmount)) / Number(borrowAmount) * 100;
  return slippagePct >= -maxSlippagePercent; // -1% まで許容（損失限定）
}

// 動的な最小利益率の計算（estimatedGasベース）
async function calculateMinProfitPercentage(
  gasPriceGwei: Gwei, 
  borrowAmountUSD: USD,
  firstSwap?: { estimatedGas?: string },
  secondSwap?: { estimatedGas?: string }
): Promise<Percentage> {
  // フォーク環境では固定の低い閾値を使用
  if (IS_FORK_ENVIRONMENT) {
    return 0.1; // 0.1%（テスト用）
  }
  
  // 価格取得失敗によるゼロ除算を防ぐ
  if (borrowAmountUSD === 0) {
    console.warn("⚠️  borrowAmountUSD is 0, using high safety threshold");
    return 99; // 99%（実質的に実行を停止）
  }
  
  // 実際のETH価格を取得（通常の価格形式）
  const ethPriceUSD = await getETHPriceUSDCached();
  
  // estimatedGasがある場合はそれを使用、なければデフォルト値
  let totalGasEstimate = Number(CONFIG.GAS.LIMIT); // 400,000 < 2^53-1なので安全
  
  if (firstSwap?.estimatedGas && secondSwap?.estimatedGas) {
    const gas1 = parseInt(firstSwap.estimatedGas);
    const gas2 = parseInt(secondSwap.estimatedGas);
    // フラッシュローンのオーバーヘッドを追加（約100,000ガス）
    totalGasEstimate = gas1 + gas2 + 100000;
  }
  
  // 実ガス履歴がある場合はそれを優先使用
  let gasCostUSD: number;
  if (STATE.avgGasUSD > 0 && STATE.gasHistory.length >= 5) {
    // 過去の実績ベース（1.2倍の安全マージン）
    gasCostUSD = STATE.avgGasUSD * 1.2;
    console.log(`📊 Using historical gas data: $${gasCostUSD.toFixed(2)} (avg: $${STATE.avgGasUSD.toFixed(2)})`);
  } else {
    // 見積もりベース
    const gasPriceWei = gasPriceGwei * 1e9; // Gwei → wei
    const gasCostWei = totalGasEstimate * gasPriceWei; // wei
    const gasCostETH = gasCostWei / 1e18; // wei → ETH
    gasCostUSD = gasCostETH * ethPriceUSD;
    console.log(`📊 Using estimated gas: $${gasCostUSD.toFixed(2)}`);
  }
  
  // ガス代の2.0倍以上の利益を確保（より積極的）
  const minProfitUSD = gasCostUSD * 2.0;
  const calculatedPercentage = (minProfitUSD / borrowAmountUSD) * 100;
  
  // 最小0.15%、最大2.5%の範囲に制限（より積極的）
  return Math.max(0.15, Math.min(2.5, calculatedPercentage));
}

// 利益計算（USD建て）- BigInt安全版
function calculateProfitUSD(
  borrowAmount: bigint,
  returnAmount: bigint,
  borrowDecimals: number,
  tokenPriceUSD: number
): { profitUSD: number; percentage: number } {
  // BigIntで精密計算（オーバーフロー対策）
  const borrowedBigInt = borrowAmount;
  const returnedBigInt = returnAmount;
  const profitTokensBigInt = returnedBigInt - borrowedBigInt;
  
  // 価格をBigIntスケールに変換（8桁精度）
  const priceScaled = BigInt(Math.round(tokenPriceUSD * 1e8));
  const profitUSDBigInt = (profitTokensBigInt * priceScaled) / BigInt(10 ** (borrowDecimals + 8));
  
  // 最後にNumber変換（toFixed直前）
  const profitUSD = Number(profitUSDBigInt) / 1e18; // 安全な範囲でNumber化
  const borrowed = Number(borrowAmount) / (10 ** borrowDecimals);
  const returned = Number(returnAmount) / (10 ** borrowDecimals);
  const percentage = ((returned - borrowed) / borrowed) * 100;
  
  return { profitUSD, percentage };
}

// Quote API使用量追跡（API乱用防止）
const quoteApiUsage = {
  hourlyCount: 0,
  lastResetTime: Date.now(),
  maxPerHour: 50 // 1時間あたり最大50回のQuote API呼び出し
};

function resetQuoteApiUsageIfNeeded() {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  if (now - quoteApiUsage.lastResetTime > oneHour) {
    quoteApiUsage.hourlyCount = 0;
    quoteApiUsage.lastResetTime = now;
    console.log(`🔄 Quote API usage reset: 0/${quoteApiUsage.maxPerHour} per hour`);
  }
}

function canUseQuoteApi(): boolean {
  resetQuoteApiUsageIfNeeded();
  return quoteApiUsage.hourlyCount < quoteApiUsage.maxPerHour;
}

function incrementQuoteApiUsage() {
  resetQuoteApiUsageIfNeeded();
  quoteApiUsage.hourlyCount++;
  console.log(`📊 Quote API usage: ${quoteApiUsage.hourlyCount}/${quoteApiUsage.maxPerHour} per hour`);
}

// 0x Protocol APIでスワップパスをチェック（Price APIのみ）
async function checkSwapPathPrice(
  fromToken: string,
  toToken: string,
  amount: bigint
): Promise<{ toAmount: bigint; estimatedGas?: string } | null> {
  try {
    const provider = API_PROVIDERS[currentProviderIndex];
    
    // Price取得のみ（Quote APIは使わない）
    const priceParams = new URLSearchParams({
      sellToken: fromToken,
      buyToken: toToken,
      sellAmount: amount.toString(),
      chainId: '1'
    });
    
    const priceUrl = provider.buildPriceUrl(priceParams);
    
    const priceResponse = await fetchWithRateLimit(
      priceUrl,
      {
        headers: provider.headers,
      }
    );
    
    if (!priceResponse.ok) {
      return null;
    }

    const priceData = await priceResponse.json();
    
    const toAmount = BigInt(priceData.buyAmount);
    const estimatedGas = priceData.gas || priceData.estimatedGas;

    return {
      toAmount,
      estimatedGas: estimatedGas?.toString()
    };

  } catch (error) {
    return null;
  }
}

// Quote APIは実際の取引時のみ呼び出す
async function getQuoteForExecution(
  fromToken: string,
  toToken: string,
  amount: bigint
): Promise<{ toAmount: bigint; calldata: string; target: string; allowanceTarget: string; estimatedGas?: string } | null> {
  try {
    // Quote API使用量制限チェック
    if (!canUseQuoteApi()) {
      console.log(`⚠️  Quote API hourly limit reached (${quoteApiUsage.maxPerHour}/hour). Skipping execution.`);
      return null;
    }

    const provider = API_PROVIDERS[currentProviderIndex];
    
    // Quote取得（実際の取引データ用）- v2対応
    const quoteParams = new URLSearchParams({
      sellToken: fromToken,
      buyToken: toToken,
      sellAmount: amount.toString(),
      taker: BALANCER_FLASH_ARB,  // takerAddressからtakerに修正（v2対応）
      slippagePercentage: '0.01',
      chainId: '1'
    });
    
    const quoteUrl = provider.buildQuoteUrl(quoteParams);
    
    console.log(`📡 Getting quote for execution: ${fromToken.slice(0, 6)}... -> ${toToken.slice(0, 6)}...`);
    
    // Quote API使用量をカウント
    incrementQuoteApiUsage();
    
    const quoteResponse = await fetchWithRateLimit(
      quoteUrl,
      {
        headers: provider.headers,
      }
    );
    
    if (!quoteResponse.ok) {
      const errorText = await quoteResponse.text();
      console.log(`❌ Quote API error: ${errorText}`);
      return null;
    }

    const quoteData = await quoteResponse.json();
    
    // Permit2 v2レスポンス形式に正しく対応
    const toAmount = BigInt(quoteData.buyAmount);
    const calldata = quoteData.data || quoteData.transaction?.data || '';
    const target = quoteData.to || quoteData.transaction?.to || '';
    const allowanceTarget = quoteData.allowanceTarget || 
                           quoteData.permit2?.eip712?.domain?.verifyingContract || 
                           '0x000000000022d473030f116ddee9f6b43ac78ba3'; // Permit2 default
    const estimatedGas = quoteData.gas || quoteData.transaction?.gas;

    return {
      toAmount,
      calldata,
      target,
      allowanceTarget,
      estimatedGas: estimatedGas?.toString()
    };

  } catch (error) {
    console.log(`❌ Quote error: ${error}`);
    return null;
  }
}

// 単一パスのアービトラージチェック（Price APIのみ）
async function checkArbitragePath(path: ArbPath, gasPriceGwei: Gwei): Promise<{
  path: ArbPath;
  opportunity?: {
    profitUSD: USD;
    percentage: Percentage;
    minPercentage: Percentage;
    firstSwapAmount: bigint;
    secondSwapAmount: bigint;
  };
  error?: string;
}> {
  try {
    // 最初のスワップをチェック（Price APIのみ）
    const firstSwap = await checkSwapPathPrice(
      path.borrowToken,
      path.targetToken,
      path.borrowAmount
    );

    if (!firstSwap) {
      return { path, error: "First swap failed" };
    }

    // 2番目のスワップをチェック（Price APIのみ）
    const secondSwap = await checkSwapPathPrice(
      path.targetToken,
      path.borrowToken,
      firstSwap.toAmount
    );

    if (!secondSwap) {
      return { path, error: "Second swap failed" };
    }

    // 利益計算
    const borrowTokenPriceUSD = await getTokenPriceUSDCached(path.borrowToken);
    const { profitUSD, percentage } = calculateProfitUSD(
      path.borrowAmount,
      secondSwap.toAmount,
      path.borrowDecimals,
      borrowTokenPriceUSD
    );

    // 最小利益率を計算
    const borrowAmountUSD = Number(path.borrowAmount) / Math.pow(10, path.borrowDecimals) * borrowTokenPriceUSD;
    const minPercentage = await calculateMinProfitPercentage(
      gasPriceGwei,
      borrowAmountUSD,
      firstSwap,
      secondSwap
    );

    if (percentage >= minPercentage) {
      console.log(`🚀 ${path.name}: +${percentage.toFixed(3)}% (>${minPercentage.toFixed(3)}%) = $${profitUSD.toFixed(2)}`);
      return {
        path,
        opportunity: {
          profitUSD,
          percentage,
          minPercentage,
          firstSwapAmount: firstSwap.toAmount,
          secondSwapAmount: secondSwap.toAmount
        }
      };
    } else {
      console.log(`📉 ${path.name}: ${percentage.toFixed(3)}% (below ${minPercentage.toFixed(3)}%)`);
      return { path };
    }

  } catch (error) {
    return { path, error: `Error: ${error}` };
  }
}

// アービトラージ機会をチェック（API負荷軽減版）
async function checkArbitrage() {
  try {
    const currentTime = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    console.log(`🔍 [${currentTime}] Scanning...`);

    // 現在のガス価格を取得
    const feeData = await currentProvider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    
    if (!gasPrice) {
      console.warn("⚠️  Failed to get gas price, using default 20 Gwei");
      return;
    }
    
    const gasPriceGwei = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));
    
    // ガス価格が高すぎる場合はスキップ
    if (gasPriceGwei > ACTIVE_CONFIG.GAS.MAX_PRICE_GWEI) {
      console.log(`⚠️  Gas too high: ${gasPriceGwei.toFixed(2)} Gwei, skipping scan`);
      return;
    }
    
    const paths = getArbPaths();

    // 積極性レベルに応じたパス数調整
    const maxPaths = AGGRESSIVENESS_LEVEL === 3 ? 8 : AGGRESSIVENESS_LEVEL === 1 ? 3 : 6;
    const limitedPaths = paths.slice(0, maxPaths);
    console.log(`🔍 Checking ${limitedPaths.length}/${paths.length} paths (Level ${AGGRESSIVENESS_LEVEL})`);

    // 全パスを順次チェック（並列処理を避けてAPI負荷軽減）
    const opportunities = [];
    for (const path of limitedPaths) {
      try {
        const result = await checkArbitragePath(path, gasPriceGwei);
        if (result.opportunity) {
          opportunities.push(result);
        }
        
        // 積極性レベルに応じた間隔調整（API負荷軽減）
        const interval = AGGRESSIVENESS_LEVEL === 3 ? 800 : AGGRESSIVENESS_LEVEL === 1 ? 1500 : 1000; // 大幅延長
        await new Promise(resolve => setTimeout(resolve, interval));
        
      } catch (error) {
        console.warn(`⚠️  Path ${path.name} failed:`, error instanceof Error ? error.message : String(error));
        continue;
      }
    }

    if (opportunities.length > 0) {
      console.log(`\n🎯 Found ${opportunities.length} profitable opportunities!`);
      
      // 最も利益の高い機会を選択
      const bestOpportunity = opportunities.reduce((best, current) => 
        current.opportunity!.profitUSD > best.opportunity!.profitUSD ? current : best
      );

      console.log(`🚀 Best opportunity: ${bestOpportunity.path.name}`);
      console.log(`💰 Expected profit: $${bestOpportunity.opportunity!.profitUSD.toFixed(2)} (${bestOpportunity.opportunity!.percentage.toFixed(3)}%)`);

      if (!IS_TEST_MODE) {
        // アービトラージを実行（実際の取引時にQuote APIを呼び出し）
        await executeArbitrageWithQuotes(
          bestOpportunity.path,
          bestOpportunity.opportunity!.profitUSD
        );
      } else {
        console.log(`⚠️  TEST MODE - monitoring only`);
      }
    } else {
      console.log(`📉 No profitable opportunities found`);
    }

    // メトリクス更新
    updateMetrics({
      activeOpportunities: opportunities.length,
      gasPrice: gasPriceGwei,
      ethPrice: await getETHPriceUSDCached()
    });

  } catch (error) {
    console.error('❌ Error in checkArbitrage:', error instanceof Error ? error.message : String(error));
  }
}

// Quote API呼び出し付きアービトラージ実行（API乱用防止）
async function executeArbitrageWithQuotes(
  path: ArbPath,
  expectedProfitUSD: number
): Promise<boolean> {
  try {
    console.log(`🧪 Getting quotes for execution: ${path.name}...`);
    
    // 実際の取引時のみQuote APIを呼び出し
    const firstSwap = await getQuoteForExecution(
      path.borrowToken,
      path.targetToken,
      path.borrowAmount
    );

    if (!firstSwap) {
      console.log(`❌ Failed to get first swap quote`);
      return false;
    }

    const secondSwap = await getQuoteForExecution(
      path.targetToken,
      path.borrowToken,
      firstSwap.toAmount
    );

    if (!secondSwap) {
      console.log(`❌ Failed to get second swap quote`);
      return false;
    }

    console.log(`✅ Got execution quotes successfully`);
    
    // 事前チェック：スリッページ再確認
    if (!checkSlippage(path.borrowAmount, secondSwap.toAmount)) {
      console.log(`⚠️  Slippage check failed, aborting`);
      return false;
    }
    
    // ガス価格チェック
    const feeData = await currentProvider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    
    if (!gasPrice) {
      console.error("❌ Failed to get gas price");
      return false;
    }

    const gasPriceGwei = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));
    
    if (gasPriceGwei > ACTIVE_CONFIG.GAS.MAX_PRICE_GWEI) {
      console.log(`⚠️  Gas too high: ${gasPriceGwei.toFixed(2)} Gwei`);
      return false;
    }

    // 利益がガス代を十分上回るかチェック（BigInt完全移行）
    const ethPriceUSD = await getETHPriceUSDCached(); // 通常の価格形式
    
    // 実際のガス見積もりを使用
    let totalGasEstimate = Number(ACTIVE_CONFIG.GAS.LIMIT);
    if (firstSwap.estimatedGas && secondSwap.estimatedGas) {
      const gas1 = parseInt(firstSwap.estimatedGas);
      const gas2 = parseInt(secondSwap.estimatedGas);
      totalGasEstimate = gas1 + gas2 + 100000; // フラッシュローンオーバーヘッド
    }
    
    // BigInt完全移行：ガス代計算
    const gasPriceWei = BigInt(Math.round(gasPriceGwei * 1e9)); // Gwei → wei (BigInt)
    const gasUsedWei = BigInt(totalGasEstimate) * gasPriceWei;
    const ethPriceScaled = BigInt(Math.round(ethPriceUSD * 1e8)); // 通常価格を8桁精度に変換
    const estimatedGasCostUSDScaled = (gasUsedWei * ethPriceScaled) / (BigInt(1e18) * BigInt(1e8));
    const estimatedGasCostUSD = Number(estimatedGasCostUSDScaled);
    
    // 動的ガス係数を使用（環境別設定）
    const gasMultiplier = IS_FORK_ENVIRONMENT ? FORK_CONFIG.PROFIT.GAS_MULTIPLIER : ACTIVE_CONFIG.PROFIT.GAS_MULTIPLIER;
    
    if (expectedProfitUSD < estimatedGasCostUSD * gasMultiplier) {
      console.log(`⚠️  Profit too low vs gas cost: $${expectedProfitUSD.toFixed(2)} < $${(estimatedGasCostUSD * gasMultiplier).toFixed(2)} (${gasMultiplier}x)`);
      return false;
    }

    console.log(`💰 Expected: $${expectedProfitUSD.toFixed(2)} | Gas: $${estimatedGasCostUSD.toFixed(2)} (${gasMultiplier}x threshold)`);

    // minProfitBpsをUSD相当分に計算
    const tokenPrice = await getTokenPriceUSDCached(path.borrowToken);
    const borrowAmountUSD = Number(ethers.formatUnits(path.borrowAmount, path.borrowDecimals)) * tokenPrice;
    const minProfitBps = calculateMinProfitBpsFromUSD(expectedProfitUSD, borrowAmountUSD);
    
    // 新しい形式でuserDataを作成：[allowanceTarget1, target1, data1, allowanceTarget2, target2, data2]
    const userData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes", "address", "address", "bytes"],
      [
        firstSwap.allowanceTarget, 
        firstSwap.target, 
        firstSwap.calldata, 
        secondSwap.allowanceTarget, 
        secondSwap.target, 
        secondSwap.calldata
      ]
    );
    
    // 🧪 Static-call シミュレーション実行
    try {
      console.log(`🧪 Running static simulation...`);
      
      const simulationResult = await currentFlashArb.executeFlashLoan.staticCall(
        [path.borrowToken],
        [path.borrowAmount],
        minProfitBps,
        userData,
        {
          gasLimit: BigInt(totalGasEstimate)
        }
      );
      
      console.log(`✅ Simulation successful! Proceeding with real transaction...`);
      
    } catch (simulationError) {
      console.log(`❌ Simulation failed:`, simulationError instanceof Error ? simulationError.message : String(simulationError));
      console.log(`🚫 Aborting real transaction to save gas`);
      return false; // シミュレーション失敗時は実取引を中止
    }
    
    // Priority Fee上限チェック（EIP-1559対応）
    const maxFeeGwei = Number(ethers.formatUnits(feeData.maxFeePerGas || BigInt(0), 'gwei'));
    
    // baseFeeの取得（ethers v6では直接取得できないため、推定値を使用）
    const baseFeeGwei = feeData.maxFeePerGas && feeData.maxPriorityFeePerGas ?
      Number(ethers.formatUnits(feeData.maxFeePerGas - feeData.maxPriorityFeePerGas, 'gwei')) :
      Number(ethers.formatUnits(feeData.gasPrice || BigInt(0), 'gwei')); // フォールバック
    
    // priorityFee ≤ maxFee - baseFee を確実に守る
    const maxPriorityGwei = Math.max(0, maxFeeGwei - baseFeeGwei);
    const priorityFeeGwei = Math.min(gasPriceGwei * 2, maxPriorityGwei * 0.9);
    
    // MEV保護：Flashbots経由で送信（フォールバック付き）
    let mevProtectedTx;
    
    if (USE_FLASHBOTS && flashbotsWallet && !IS_FORK_ENVIRONMENT) {
      try {
        console.log(`🔒 Sending via Flashbots...`);
        const flashbotsArb = new ethers.Contract(BALANCER_FLASH_ARB, abi, flashbotsWallet);
        
        // Flashbots用のnonce取得
        const flashbotsNonce = await flashbotsWallet.getNonce();
        
        mevProtectedTx = await flashbotsArb.executeFlashLoan(
          [path.borrowToken],
          [path.borrowAmount],
          minProfitBps,
          userData,
          {
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: ethers.parseUnits(priorityFeeGwei.toFixed(1), 'gwei'),
            gasLimit: BigInt(totalGasEstimate),
            nonce: flashbotsNonce
          }
        );
        
        console.log(`🔒 Flashbots TX: ${mevProtectedTx.hash}`);
      } catch (flashbotsError) {
        console.warn(`⚠️  Flashbots failed, falling back to public mempool:`, flashbotsError instanceof Error ? flashbotsError.message : String(flashbotsError));
        
        // フォールバック：新しいnonceで通常のRPC
        const publicNonce = await wallet.getNonce();
        
        mevProtectedTx = await currentFlashArb.executeFlashLoan(
          [path.borrowToken],
          [path.borrowAmount],
          minProfitBps,
          userData,
          {
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: ethers.parseUnits(priorityFeeGwei.toFixed(1), 'gwei'),
            gasLimit: BigInt(totalGasEstimate),
            nonce: publicNonce
          }
        );
      }
    } else {
      // 通常のRPC（フォーク環境またはFlashbots無効時）
      if (USE_FLASHBOTS && !flashbotsWallet) {
        console.warn(`⚠️  Flashbots enabled but wallet not configured, using public mempool`);
      }
      
      mevProtectedTx = await currentFlashArb.executeFlashLoan(
        [path.borrowToken],
        [path.borrowAmount],
        minProfitBps,
        userData,
        {
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: ethers.parseUnits(priorityFeeGwei.toFixed(1), 'gwei'),
          gasLimit: BigInt(totalGasEstimate)
        }
      );
    }

    console.log(`🚀 Transaction sent: ${mevProtectedTx.hash}`);
    console.log(`⏳ Waiting for confirmation...`);

    // トランザクション確認
    const receipt = await mevProtectedTx.wait();
    
    if (receipt && receipt.status === 1) {
      console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
      console.log(`💰 Arbitrage executed successfully!`);
      
      // メトリクス更新
      updateMetrics({
        transactionStatus: 'success',
        pair: path.name,
        profitUSD: expectedProfitUSD,
        token: path.borrowToken,
        executionTime: Date.now() / 1000,
        gasCostUSD: estimatedGasCostUSD
      });
      
      return true;
    } else {
      console.log(`❌ Transaction failed`);
      updateMetrics({
        transactionStatus: 'failed',
        pair: path.name,
        failureReason: 'transaction_failed',
        gasCostUSD: estimatedGasCostUSD
      });
      return false;
    }

  } catch (error) {
    console.error(`❌ Arbitrage execution error:`, error instanceof Error ? error.message : String(error));
    updateMetrics({
      transactionStatus: 'failed',
      pair: path.name,
      failureReason: 'execution_error',
      gasCostUSD: 0
    });
    return false;
  }
}

// WebSocket再接続ロジック
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000; // 5秒

// グローバルプロバイダーとコントラクト参照
let currentProvider = provider;
let currentFlashArb = flashArb;

async function reconnectProvider(): Promise<void> {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error("❌ Max reconnection attempts reached. Exiting...");
    process.exit(1);
  }
  
  reconnectAttempts++;
  console.log(`🔄 Reconnecting... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  
  await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
  
  try {
    // 新しいプロバイダーとコントラクトを作成
    const newProvider = new ethers.JsonRpcProvider(RPC_URL);
    const newWallet = new ethers.Wallet(PRIVATE_KEY!, newProvider);
    const newFlashArb = new ethers.Contract(BALANCER_FLASH_ARB, abi, newWallet);
    
    // 接続テスト
    await newProvider.getBlockNumber();
    
    // 古いプロバイダーのリスナーを削除
    currentProvider.removeAllListeners();
    
    // グローバル参照を更新
    currentProvider = newProvider;
    currentFlashArb = newFlashArb;
    
    console.log("✅ Reconnected successfully!");
    reconnectAttempts = 0; // リセット
    
    // 新しいリスナーを設定
    setupProviderListeners();
    
  } catch (error) {
    console.error(`❌ Reconnection failed:`, error instanceof Error ? error.message : String(error));
    await reconnectProvider(); // 再帰的に再試行
  }
}

function setupProviderListeners(): void {
  // エラーハンドリング
  currentProvider.on("error", async (error) => {
    console.error("🔌 Provider error:", error.message);
    await reconnectProvider();
  });

  // ブロック監視
  currentProvider.on("block", async (blockNumber) => {
    try {
      // 5ブロックごとにスキャン（約1分間隔、積極的）
      if (blockNumber % ACTIVE_CONFIG.MONITORING.BLOCK_INTERVAL === 0) {
        STATE.lastBlockNumber = blockNumber;
        
        // パフォーマンス統計を定期的に表示
        if (blockNumber % 30 === 0) { // 10分ごと（30ブロック）
          displayPerformanceStats();
        }
        
      await checkArbitrageWithRiskManagement();
      }
    } catch (error) {
      console.error(`❌ Block ${blockNumber} error:`, error instanceof Error ? error.message : String(error));
    }
  });
}

// メイン実行関数（ログ簡潔化）
async function main() {
  console.log("🔍 Balancer Flash Loan Arbitrage Scanner");
  console.log(`📊 ${NETWORK_NAME} ${IS_FORK_ENVIRONMENT ? '🧪' : '🔴'} | Contract: ${BALANCER_FLASH_ARB}`);
  console.log(`⚙️  Min Profit: ${IS_FORK_ENVIRONMENT ? FORK_CONFIG.PROFIT.MIN_PERCENTAGE : ACTIVE_CONFIG.PROFIT.MIN_PERCENTAGE}% | Mode: ${IS_TEST_MODE ? "TEST" : "LIVE"} | Level: ${AGGRESSIVENESS_LEVEL}`);
  console.log(`🔥 Aggressiveness: ${AGGRESSIVENESS_LEVEL === 1 ? "Conservative" : AGGRESSIVENESS_LEVEL === 3 ? "Aggressive" : "Balanced"} | Scan: ${ACTIVE_CONFIG.MONITORING.BLOCK_INTERVAL} blocks`);
  
  // メトリクスサーバー起動
  if (process.env.METRICS_ENABLED === "true") {
    startMetricsServer();
  }
  
  // 自動引き出し設定表示
  if (AUTO_WITHDRAW_ENABLED) {
    const tokenName = AUTO_WITHDRAW_TOKEN === USDC ? 'USDC' : 
                     AUTO_WITHDRAW_TOKEN === DAI ? 'DAI' : 
                     AUTO_WITHDRAW_TOKEN === WETH ? 'WETH' : 'TOKEN';
    console.log(`💸 Auto-withdraw: $${AUTO_WITHDRAW_THRESHOLD} in ${tokenName}`);
  } else {
    console.log(`💸 Auto-withdraw: DISABLED`);
  }
  
  // 初期残高表示
  const balance = await currentProvider.getBalance(wallet.address);
  console.log(`💰 Balance: ${ethers.formatEther(balance)} ETH`);
  
  if (IS_FORK_ENVIRONMENT) {
    console.log(`🧪 Fork amounts: USDC ${ethers.formatUnits(FORK_CONFIG.AMOUNTS.USDC, 6)}, WETH ${ethers.formatUnits(FORK_CONFIG.AMOUNTS.WETH, 18)}`);
  }
  
  STATE.startTime = Date.now();
  
  // ブロック監視開始
  setupProviderListeners();
  
  console.log("👀 Monitoring blocks...");
}

// パフォーマンス統計表示（簡潔化）
function displayPerformanceStats() {
  const runtime = (Date.now() - STATE.startTime) / 1000 / 60; // 分
  const successRate = STATE.totalTransactions > 0 ? 
    (STATE.successfulTransactions / STATE.totalTransactions * 100) : 0;
  
  console.log("\n📊 === STATS ===");
  console.log(`⏱️  ${runtime.toFixed(1)}min | 💰 $${STATE.totalProfit.toFixed(2)} | 📈 ${STATE.successfulTransactions}/${STATE.totalTransactions} (${successRate.toFixed(1)}%)`);
  console.log(`💰 $/hour: $${(STATE.totalProfit / runtime * 60).toFixed(2)} | 🧱 Block: ${STATE.lastBlockNumber}`);
  console.log(`⛽ Avg Gas/Tx: $${STATE.avgGasUSD.toFixed(2)} | 📊 History: ${STATE.gasHistory.length} samples`);
  console.log("===============\n");
}

// 自動引き出し関数
async function autoWithdraw(): Promise<void> {
  if (!AUTO_WITHDRAW_ENABLED) {
    return;
  }
  
  if (STATE.totalProfit < AUTO_WITHDRAW_THRESHOLD) {
    return;
  }
  
  try {
    console.log(`\n💸 Auto-withdrawal triggered! Profit: $${STATE.totalProfit.toFixed(2)}`);
    
    // 引き出し前の残高確認
    const tokenContract = new ethers.Contract(
      AUTO_WITHDRAW_TOKEN,
      ["function balanceOf(address) view returns (uint256)"],
      currentProvider
    );
    
    const balanceBefore = await tokenContract.balanceOf(BALANCER_FLASH_ARB);
    
    // トークンのdecimals取得（動的）
    const decimals = await getTokenDecimals(AUTO_WITHDRAW_TOKEN);
    
    console.log(`💰 Contract balance before: ${ethers.formatUnits(balanceBefore, decimals)} tokens`);
    
    if (balanceBefore === BigInt(0)) {
      console.log("⚠️  No tokens to withdraw");
      return;
    }
    
    // 引き出し実行
    const tx = await currentFlashArb.withdraw(AUTO_WITHDRAW_TOKEN);
    console.log(`📜 Withdrawal TX: ${tx.hash}`);
    
    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      // 引き出し後の残高確認
      const balanceAfter = await tokenContract.balanceOf(BALANCER_FLASH_ARB);
      const withdrawnAmount = balanceBefore - balanceAfter;
      
      console.log(`✅ Auto-withdrawal successful!`);
      console.log(`💵 Withdrawn: ${ethers.formatUnits(withdrawnAmount, decimals)} tokens`);
      console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);
      
      // 統計をリセット（引き出し後）
      STATE.totalProfit = 0;
      console.log(`📊 Profit counter reset`);
      
    } else {
      console.log(`❌ Auto-withdrawal transaction failed`);
    }
    
  } catch (error) {
    console.error("⚠️  Auto-withdrawal failed:", error instanceof Error ? error.message : String(error));
  }
}

// トークンdecimals キャッシュ
const decimalsCache = new Map<string, number>();

// トークンのdecimalsを取得（キャッシュ付き）
async function getTokenDecimals(tokenAddress: string): Promise<number> {
  const cacheKey = tokenAddress.toLowerCase();
  const cached = decimalsCache.get(cacheKey);
  
  if (cached !== undefined) {
    return cached;
  }
  
  try {
    // IERC20Metadata.decimals()を呼び出し
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ["function decimals() view returns (uint8)"],
      currentProvider
    );
    
    const decimals = await tokenContract.decimals();
    decimalsCache.set(cacheKey, decimals);
    return decimals;
    
  } catch (error) {
    // フォールバック：既知のトークンのdecimals
    const fallbackDecimals = tokenAddress === USDC || tokenAddress === USDT ? 6 :
                             tokenAddress === WBTC ? 8 : 18;
    decimalsCache.set(cacheKey, fallbackDecimals);
    return fallbackDecimals;
  }
}

// minProfitBpsをUSD相当分に変換（slippage対応）
function calculateMinProfitBpsFromUSD(
  expectedProfitUSD: number,
  borrowAmountUSD: number,
  safetyMarginBps: number = 150 // 1.5%の安全マージン（MEV・slippage対応）
): number {
  const profitPercentage = (expectedProfitUSD / borrowAmountUSD) * 100;
  
  // 実際のfilled amountが滑ることを考慮して、より保守的に設定（70%）
  const conservativeProfitBps = Math.ceil(profitPercentage * 100 * 0.7) - safetyMarginBps;
  
  // 最小10bps（0.1%）、最大1000bps（10%）に制限
  return Math.max(10, Math.min(1000, conservativeProfitBps));
}

/**
 * Static-callでアービトラージをシミュレーション（revert理由デコード付き）
 */
async function simulateArbitrage(
  contract: ethers.Contract,
  tokens: string[],
  amounts: bigint[],
  minProfitBps: number,
  userData: string
): Promise<{ success: boolean; error?: string; gasEstimate?: bigint }> {
  try {
    // Static-callでシミュレーション
    const result = await contract.executeFlashLoan.staticCall(
      tokens,
      amounts,
      minProfitBps,
      userData
    );
    
    // ガス見積もりも取得
    const gasEstimate = await contract.executeFlashLoan.estimateGas(
      tokens,
      amounts,
      minProfitBps,
      userData
    );
    
    console.log(`✅ Simulation successful, estimated gas: ${gasEstimate.toString()}`);
    return { success: true, gasEstimate };
    
  } catch (error: any) {
    // revert理由をデコード
    const decodedError = decodeRevertReason(error);
    console.warn(`⚠️  Simulation failed: ${decodedError}`);
    
    return { 
      success: false, 
      error: decodedError 
    };
  }
}

/**
 * revert理由をデコードして可読化
 */
function decodeRevertReason(error: any): string {
  try {
    // ethers.jsのエラーから情報を抽出
    if (error.reason) {
      return error.reason;
    }
    
    if (error.data) {
      const errorData = error.data;
      
      // "0x"で始まる場合はhexデータ
      if (typeof errorData === 'string' && errorData.startsWith('0x')) {
        // 空のrevert（"0x"）の場合
        if (errorData === '0x') {
          return 'Empty revert (no reason provided)';
        }
        
        // Error(string)のシグネチャ: 0x08c379a0
        if (errorData.startsWith('0x08c379a0')) {
          try {
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
              ['string'],
              '0x' + errorData.slice(10) // シグネチャを除去
            );
            return `Error: ${decoded[0]}`;
          } catch {
            return `Error with data: ${errorData}`;
          }
        }
        
        // Panic(uint256)のシグネチャ: 0x4e487b71
        if (errorData.startsWith('0x4e487b71')) {
          try {
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
              ['uint256'],
              '0x' + errorData.slice(10)
            );
            const panicCode = decoded[0];
            return `Panic: ${getPanicReason(Number(panicCode))} (code: ${panicCode})`;
          } catch {
            return `Panic with data: ${errorData}`;
          }
        }
        
        // カスタムエラーの可能性
        const errorSignature = errorData.slice(0, 10);
        const customErrorName = getCustomErrorName(errorSignature);
        if (customErrorName) {
          return `Custom error: ${customErrorName} (${errorData})`;
        }
        
        return `Unknown error with data: ${errorData}`;
      }
    }
    
    // フォールバック
    if (error.message) {
      return error.message;
    }
    
    return String(error);
    
  } catch (decodeError) {
    return `Failed to decode error: ${String(error)}`;
  }
}

/**
 * Panicコードから理由を取得
 */
function getPanicReason(code: number): string {
  const panicReasons: { [key: number]: string } = {
    0x00: 'Generic compiler inserted panic',
    0x01: 'Assertion failed',
    0x11: 'Arithmetic overflow/underflow',
    0x12: 'Division or modulo by zero',
    0x21: 'Invalid enum value',
    0x22: 'Invalid storage byte array access',
    0x31: 'Pop on empty array',
    0x32: 'Array index out of bounds',
    0x41: 'Out of memory',
    0x51: 'Invalid function selector'
  };
  
  return panicReasons[code] || 'Unknown panic reason';
}

/**
 * カスタムエラーシグネチャから名前を取得
 */
function getCustomErrorName(signature: string): string | null {
  const customErrors: { [key: string]: string } = {
    '0x82b42900': 'Unauthorized',
    '0x8bb30a0e': 'SwapFailed', 
    '0x963b34a5': 'InsufficientProfit',
    '0x2c5211c6': 'InvalidAmount',
    '0x90b8ec18': 'TransferFailed',
    '0x39a84a7b': 'UntrustedSpender',
    '0x7939f424': 'InvalidFeeAmount'
  };
  
  return customErrors[signature] || null;
}

/**
 * 💡 包括的リスク評価関数
 */
async function assessOpportunityRisk(
  opportunity: {
    path: ArbPath;
    profitUSD: number;
    percentage: number;
    borrowAmountUSD: number;
  },
  gasPriceGwei: number
): Promise<{
  shouldExecute: boolean;
  riskScore: number;
  warnings: string[];
  blockingReasons: string[];
}> {
  const warnings: string[] = [];
  const blockingReasons: string[] = [];
  let riskScore = 0;

  // 1️⃣ 損失制限チェック
  if (RISK_STATE.dailyLoss >= RISK_LIMITS.MAX_DAILY_LOSS_USD) {
    blockingReasons.push(`Daily loss limit reached: $${RISK_STATE.dailyLoss.toFixed(2)}`);
  }
  
  if (RISK_STATE.hourlyLoss >= RISK_LIMITS.MAX_HOURLY_LOSS_USD) {
    blockingReasons.push(`Hourly loss limit reached: $${RISK_STATE.hourlyLoss.toFixed(2)}`);
  }

  // 2️⃣ 成功率チェック
  const recentSuccessRate = calculateRecentSuccessRate();
  if (recentSuccessRate < RISK_LIMITS.MIN_SUCCESS_RATE) {
    riskScore += 0.3;
    warnings.push(`Low success rate: ${(recentSuccessRate * 100).toFixed(1)}%`);
    
    // 連続失敗が多い場合は一時停止
    if (RISK_STATE.consecutiveFailures >= 3) {
      blockingReasons.push(`Too many consecutive failures: ${RISK_STATE.consecutiveFailures}`);
    }
  }

  // 3️⃣ クールダウンチェック
  const timeSinceLastLoss = Date.now() - RISK_STATE.lastLossTime;
  if (RISK_STATE.lastLossTime > 0 && timeSinceLastLoss < RISK_LIMITS.COOLDOWN_AFTER_LOSS_MS) {
    const remainingCooldown = Math.ceil((RISK_LIMITS.COOLDOWN_AFTER_LOSS_MS - timeSinceLastLoss) / 1000);
    blockingReasons.push(`Cooldown active: ${remainingCooldown}s remaining`);
  }

  // 4️⃣ ガス価格リスク
  if (gasPriceGwei > ACTIVE_CONFIG.GAS.MAX_PRICE_GWEI * 0.8) {
    riskScore += 0.2;
    warnings.push(`High gas price: ${gasPriceGwei.toFixed(2)} Gwei`);
  }

  // 5️⃣ 利益マージンチェック  
  const ethPriceUSD = await getETHPriceUSDCached();
  const estimatedGasCostUSD = (gasPriceGwei * 1e9 * 400000 * ethPriceUSD) / 1e18;
  const profitMargin = opportunity.profitUSD / estimatedGasCostUSD;
  
  if (profitMargin < 3.0) { // ガス代の3倍未満は高リスク
    riskScore += 0.25;
    warnings.push(`Low profit margin: ${profitMargin.toFixed(2)}x gas cost`);
  }

  // 6️⃣ 借入額リスク
  if (opportunity.borrowAmountUSD > 50000) { // $50k超
    riskScore += 0.15;
    warnings.push(`Large position: $${opportunity.borrowAmountUSD.toFixed(0)}`);
  }

  // 7️⃣ 流動性チェック（簡易版）
  const estimatedLiquidity = await estimatePoolLiquidity(
    opportunity.path.borrowToken,
    opportunity.path.targetToken
  );
  
  if (estimatedLiquidity < RISK_LIMITS.MIN_LIQUIDITY_USD) {
    riskScore += 0.2;
    warnings.push(`Low liquidity: $${estimatedLiquidity.toFixed(0)}`);
  }

  // 8️⃣ 総合判定
  const shouldExecute = blockingReasons.length === 0 && riskScore < 0.7;

  return {
    shouldExecute,
    riskScore,
    warnings,
    blockingReasons
  };
}

/**
 * 📊 最近の成功率計算
 */
function calculateRecentSuccessRate(): number {
  const oneHourAgo = Date.now() - 3600000;
  const recentTxs = RISK_STATE.recentTransactions.filter(tx => tx.timestamp > oneHourAgo);
  
  if (recentTxs.length === 0) return 1.0; // データなしの場合は100%とする
  
  const successfulTxs = recentTxs.filter(tx => tx.success).length;
  return successfulTxs / recentTxs.length;
}

/**
 * 💧 流動性推定（簡易版）
 */
async function estimatePoolLiquidity(token0: string, token1: string): Promise<number> {
  try {
    // 大きな額での価格インパクトをチェック
    const testAmount = ethers.parseUnits("100000", 6); // $100k相当
    
    const smallSwap = await checkSwapPathPrice(token0, token1, testAmount);
    const largeSwap = await checkSwapPathPrice(token0, token1, testAmount * BigInt(10));
    
    if (!smallSwap || !largeSwap) return 0;
    
    // 価格インパクトから流動性を推定
    const smallPrice = Number(smallSwap.toAmount) / Number(testAmount);
    const largePrice = Number(largeSwap.toAmount) / Number(testAmount * BigInt(10));
    
    const priceImpact = Math.abs(largePrice - smallPrice) / smallPrice;
    
    // 価格インパクトが小さいほど流動性が高い
    if (priceImpact < 0.01) return 1000000; // $1M+
    if (priceImpact < 0.05) return 500000;  // $500k
    if (priceImpact < 0.1) return 100000;   // $100k
    return 50000; // $50k未満
    
  } catch (error) {
    console.warn('⚠️ Liquidity estimation failed:', error);
    return 100000; // デフォルト値
  }
}

/**
 * 📝 取引結果の記録
 */
function recordTransactionResult(profitUSD: number, success: boolean): void {
  const transaction = {
    timestamp: Date.now(),
    profit: profitUSD,
    success
  };
  
  RISK_STATE.recentTransactions.push(transaction);
  
  // 24時間以上古いデータを削除
  const oneDayAgo = Date.now() - 86400000;
  RISK_STATE.recentTransactions = RISK_STATE.recentTransactions.filter(
    tx => tx.timestamp > oneDayAgo
  );
  
  // 損失の場合の処理
  if (!success || profitUSD < 0) {
    const lossAmount = Math.abs(profitUSD);
    RISK_STATE.dailyLoss += lossAmount;
    RISK_STATE.hourlyLoss += lossAmount;
    RISK_STATE.lastLossTime = Date.now();
    RISK_STATE.consecutiveFailures++;
    
    console.log(`📉 Loss recorded: $${lossAmount.toFixed(2)} | Daily: $${RISK_STATE.dailyLoss.toFixed(2)} | Failures: ${RISK_STATE.consecutiveFailures}`);
  } else {
    // 成功時は連続失敗回数をリセット
    RISK_STATE.consecutiveFailures = 0;
  }
}

/**
 * 🚨 基本的なアラート機能
 */
async function sendBasicAlert(message: string, level: 'info' | 'warning' | 'error' = 'info'): Promise<void> {
  const emoji = level === 'error' ? '🚨' : level === 'warning' ? '⚠️' : 'ℹ️';
  const alertMessage = `${emoji} [${level.toUpperCase()}] ${message}`;
  
  console.log(alertMessage);
  
  // Slack通知（Webhook URLが設定されている場合）
  if (process.env.SLACK_WEBHOOK_URL && level !== 'info') {
    try {
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: alertMessage,
          channel: '#arbitrage-alerts'
        })
      });
    } catch (error) {
      console.warn('⚠️ Failed to send Slack alert:', error);
    }
  }
}

/**
 * 🛡️ リスク管理対応メイン関数
 */
async function checkArbitrageWithRiskManagement(): Promise<void> {
  try {
    const currentTime = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    console.log(`🔍 [${currentTime}] Scanning with risk management...`);

    // 現在のガス価格を取得
    const feeData = await currentProvider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    
    if (!gasPrice) {
      console.warn("⚠️ Failed to get gas price, using default 20 Gwei");
      return;
    }
    
    const gasPriceGwei = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));
    
    // ガス価格が高すぎる場合はスキップ
    if (gasPriceGwei > ACTIVE_CONFIG.GAS.MAX_PRICE_GWEI) {
      await sendBasicAlert(`Gas price too high: ${gasPriceGwei.toFixed(2)} Gwei`, 'warning');
      return;
    }
    
    const paths = getArbPaths();
    const maxPaths = AGGRESSIVENESS_LEVEL === 3 ? 8 : AGGRESSIVENESS_LEVEL === 1 ? 3 : 6;
    const limitedPaths = paths.slice(0, maxPaths);

    // 全パスを順次チェック
    const opportunities = [];
    for (const path of limitedPaths) {
      try {
        const result = await checkArbitragePath(path, gasPriceGwei);
        if (result.opportunity) {
          // 📊 リスク評価を追加
          const borrowTokenPriceUSD = await getTokenPriceUSDCached(path.borrowToken);
          const borrowAmountUSD = Number(path.borrowAmount) / Math.pow(10, path.borrowDecimals) * borrowTokenPriceUSD;
          
          const riskAssessment = await assessOpportunityRisk({
            path,
            profitUSD: result.opportunity.profitUSD,
            percentage: result.opportunity.percentage,
            borrowAmountUSD
          }, gasPriceGwei);
          
          if (riskAssessment.shouldExecute) {
            opportunities.push(result);
            
            // 警告がある場合は表示
            if (riskAssessment.warnings.length > 0) {
              console.log(`⚠️ Warnings for ${path.name}: ${riskAssessment.warnings.join(', ')}`);
            }
          } else {
            console.log(`🚫 ${path.name} blocked: ${riskAssessment.blockingReasons.join(', ')}`);
            if (riskAssessment.blockingReasons.length > 0) {
              await sendBasicAlert(`Execution blocked: ${riskAssessment.blockingReasons[0]}`, 'warning');
            }
          }
        }
        
        const interval = AGGRESSIVENESS_LEVEL === 3 ? 800 : AGGRESSIVENESS_LEVEL === 1 ? 1500 : 1000;
        await new Promise(resolve => setTimeout(resolve, interval));
        
      } catch (error) {
        console.warn(`⚠️ Path ${path.name} failed:`, error instanceof Error ? error.message : String(error));
        continue;
      }
    }

    if (opportunities.length > 0) {
      console.log(`\n🎯 Found ${opportunities.length} risk-approved opportunities!`);
      
      // 最も利益の高い機会を選択
      const bestOpportunity = opportunities.reduce((best, current) => 
        current.opportunity!.profitUSD > best.opportunity!.profitUSD ? current : best
      );

      console.log(`🚀 Best opportunity: ${bestOpportunity.path.name}`);
      console.log(`💰 Expected profit: $${bestOpportunity.opportunity!.profitUSD.toFixed(2)} (${bestOpportunity.opportunity!.percentage.toFixed(3)}%)`);

      // 大きな利益の場合はアラート送信
      if (bestOpportunity.opportunity!.profitUSD > 200) {
        await sendBasicAlert(
          `Large opportunity found: $${bestOpportunity.opportunity!.profitUSD.toFixed(2)} on ${bestOpportunity.path.name}`,
          'info'
        );
      }

      if (!IS_TEST_MODE) {
        // アービトラージを実行
        const executionSuccess = await executeArbitrageWithQuotes(
          bestOpportunity.path,
          bestOpportunity.opportunity!.profitUSD
        );
        
        // 📝 結果を記録
        recordTransactionResult(
          executionSuccess ? bestOpportunity.opportunity!.profitUSD : -50, // 失敗時は$50の損失と仮定
          executionSuccess
        );
      } else {
        console.log(`⚠️ TEST MODE - monitoring only`);
      }
    } else {
      console.log(`📉 No profitable opportunities found (or all blocked by risk management)`);
    }

    // メトリクス更新
    updateMetrics({
      activeOpportunities: opportunities.length,
      gasPrice: gasPriceGwei,
      ethPrice: await getETHPriceUSDCached()
    });

  } catch (error) {
    console.error('❌ Error in checkArbitrageWithRiskManagement:', error instanceof Error ? error.message : String(error));
    await sendBasicAlert(`System error: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});