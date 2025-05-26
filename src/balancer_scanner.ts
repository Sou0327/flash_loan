import { ethers } from "ethers";
import { z } from 'zod';
import { startMetricsServer, updateMetrics } from './metrics';
import * as dotenv from "dotenv";

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
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

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
    MAX_PRICE_GWEI: 25,           // 少し高めに調整
    PRIORITY_FEE_GWEI: 1.5,       // MEV保護用の優先料金
  },
  
  // 利益設定（動的計算）
  PROFIT: {
    MIN_PERCENTAGE: 0.2,      // 0.2%（$100利益）
    MIN_AMOUNT_USD: 100,      // ガス代を考慮（増額）
  },
  
  // 実行制御
  EXECUTION: {
    CHECK_INTERVAL_BLOCKS: 3, // 3ブロックごとにチェック
    MAX_SLIPPAGE: 1,          // 最大スリッページ 1%
  },
  
  MONITORING: {
    BLOCK_INTERVAL: 3,        // 3ブロックごとにスキャン
    MAX_SLIPPAGE_PERCENT: 0.5, // 最大スリッページ
  }
};

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
    baseUrl: "https://api.0x.org/swap/v1",
    headers: { '0x-api-key': apiKey },
    buildPriceUrl: (params: URLSearchParams) => `https://api.0x.org/swap/v1/price?${params.toString()}`,
    buildQuoteUrl: (params: URLSearchParams) => `https://api.0x.org/swap/v1/quote?${params.toString()}`,
    rateLimitHeaders: {
      remaining: 'x-ratelimit-remaining',
      reset: 'x-ratelimit-reset'
    }
  },
  {
    name: "1inch",
    baseUrl: "https://api.1inch.dev/swap/v5.2/1",
    headers: { 'Authorization': `Bearer ${process.env.ONEINCH_API_KEY}` },
    buildPriceUrl: (params: URLSearchParams) => {
      // 1inch用のパラメータ変換
      const fromToken = params.get('sellToken');
      const toToken = params.get('buyToken');
      const amount = params.get('sellAmount');
      return `https://api.1inch.dev/swap/v5.2/1/quote?fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&amount=${amount}`;
    },
    buildQuoteUrl: (params: URLSearchParams) => {
      // 1inch用のパラメータ変換
      const fromToken = params.get('sellToken');
      const toToken = params.get('buyToken');
      const amount = params.get('sellAmount');
      const slippage = params.get('slippagePercentage') || '1'; // デフォルト1%
      const from = params.get('takerAddress');
      return `https://api.1inch.dev/swap/v5.2/1/swap?fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&amount=${amount}&fromAddress=${from}&slippage=${slippage}`;
    },
    rateLimitHeaders: {
      remaining: 'x-rate-limit-remaining',
      reset: 'x-rate-limit-reset'
    }
  }
];

let currentProviderIndex = 0;
const rateLimitState = new Map<string, { resetTime: number; remaining: number }>();

// Rate-limit対応のfetch
async function fetchWithRateLimit(url: string, options: any, retries = 3): Promise<any> {
  const provider = API_PROVIDERS[currentProviderIndex];
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Rate-limit チェック
      const rateLimitKey = provider.name;
      const rateLimit = rateLimitState.get(rateLimitKey);
      
      if (rateLimit && Date.now() < rateLimit.resetTime && rateLimit.remaining <= 0) {
        const waitTime = rateLimit.resetTime - Date.now();
        console.log(`⏳ Rate limited, waiting ${waitTime}ms for ${provider.name}`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      const response = await fetch(url, {
        ...options,
        headers: provider.headers // 完全にprovider.headersで置き換え
      });
      
      // Rate-limit ヘッダーを保存（provider別）
      const remainingHeader = provider.rateLimitHeaders.remaining;
      const resetHeader = provider.rateLimitHeaders.reset;
      
      const remaining = Number(response.headers.get(remainingHeader) ?? '100');
      const resetTime = Number(response.headers.get(resetHeader) ?? '0') * 1000;
      
      // NaN耐性チェック
      const safeRemaining = isNaN(remaining) ? 100 : remaining;
      const safeResetTime = isNaN(resetTime) ? Date.now() + 60000 : resetTime; // 1分後にリセット
      
      rateLimitState.set(rateLimitKey, { resetTime: safeResetTime, remaining: safeRemaining });
      
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '1') * 1000;
        console.log(`⏳ Rate limited by ${provider.name}, waiting ${retryAfter}ms`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        continue;
      }
      
      if (response.status >= 500) {
        console.warn(`⚠️  ${provider.name} server error (${response.status}), trying next provider`);
        currentProviderIndex = (currentProviderIndex + 1) % API_PROVIDERS.length;
        continue;
      }
      
      return response;
      
    } catch (error) {
      console.warn(`⚠️  ${provider.name} failed (attempt ${attempt + 1}):`, error);
      
      if (attempt === retries - 1) {
        // 最後の試行でも失敗したら次のプロバイダーに切り替え
        currentProviderIndex = (currentProviderIndex + 1) % API_PROVIDERS.length;
        throw error;
      }
      
      // 指数バックオフ
      const backoffTime = Math.min(1000 * Math.pow(2, attempt), 10000);
      await new Promise(resolve => setTimeout(resolve, backoffTime));
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
    // 0x API v1から価格を取得
    const response = await fetchWithRateLimit(
      `https://api.0x.org/swap/v1/price?sellToken=${tokenAddress}&buyToken=${USDC}&sellAmount=1000000000000000000`,
      {
        headers: { 
          '0x-api-key': apiKey
        },
      }
    );
    
    if (response.ok) {
      const data = await response.json() as any;
      const price = data.price;
      if (price) {
        return parseFloat(price);
      }
    }
  } catch (error) {
    // フォールバック価格を使用
  }
  
  // フォールバック価格マッピング
  const priceMap: { [key: string]: number } = {
    [USDC.toLowerCase()]: 1.0,
    [DAI.toLowerCase()]: 1.0,
    [USDT.toLowerCase()]: 1.0,
    [WETH.toLowerCase()]: 3000, // フォールバック価格
    [WBTC.toLowerCase()]: 60000, // フォールバック価格
  };
  
  const normalizedAddress = tokenAddress.toLowerCase();
  return priceMap[normalizedAddress] || 1.0;
}

// ETH/USD価格を取得する専用関数
async function getETHPriceUSD(): Promise<number> {
  try {
    // 0x API v1でETH/USDC価格を取得
    const response = await fetchWithRateLimit(
      `https://api.0x.org/swap/v1/price?sellToken=${WETH}&buyToken=${USDC}&sellAmount=1000000000000000000`,
      {
        headers: { 
          '0x-api-key': apiKey
        },
      }
    );
    
    if (response.ok) {
      const data = await response.json() as any;
      const price = data.price;
      if (price) {
        return parseFloat(price);
      }
    }
  } catch (error) {
    // フォールバック
  }
  
  return 3000; // フォールバック価格
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
  gasPriceGwei: number, 
  borrowAmountUSD: number,
  firstSwap?: { estimatedGas?: string },
  secondSwap?: { estimatedGas?: string }
): Promise<number> {
  // フォーク環境では固定の低い閾値を使用
  if (IS_FORK_ENVIRONMENT) {
    return 0.1; // 0.1%（テスト用）
  }
  
  // 実際のETH価格を取得
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
    const gasCostETH = (totalGasEstimate * gasPriceGwei) / 1e9;
    gasCostUSD = gasCostETH * ethPriceUSD;
    console.log(`📊 Using estimated gas: $${gasCostUSD.toFixed(2)}`);
  }
  
  // ガス代の2.5倍以上の利益を確保（より保守的）
  const minProfitUSD = gasCostUSD * 2.5;
  const calculatedPercentage = (minProfitUSD / borrowAmountUSD) * 100;
  
  // 最小0.2%、最大3%の範囲に制限（ガス高騰時対応）
  return Math.max(0.2, Math.min(3.0, calculatedPercentage));
}

// 利益計算（USD建て）
function calculateProfitUSD(
  borrowAmount: bigint,
  returnAmount: bigint,
  borrowDecimals: number,
  tokenPriceUSD: number
): { profitUSD: number; percentage: number } {
  const borrowed = Number(borrowAmount) / (10 ** borrowDecimals);
  const returned = Number(returnAmount) / (10 ** borrowDecimals);
  const profitTokens = returned - borrowed;
  const profitUSD = profitTokens * tokenPriceUSD;
  const percentage = (profitTokens / borrowed) * 100;
  return { profitUSD, percentage };
}

// 0x Protocol APIでスワップパスをチェック
async function checkSwapPath(
  fromToken: string,
  toToken: string,
  amount: bigint
): Promise<{ toAmount: bigint; calldata: string; target: string; allowanceTarget: string; estimatedGas?: string } | null> {
  try {
    const provider = API_PROVIDERS[currentProviderIndex];
    
    // 1. Price取得（見積もり用）
    const priceParams = new URLSearchParams({
      sellToken: fromToken,
      buyToken: toToken,
      sellAmount: amount.toString()
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
    
    // Zodバリデーション
    const validatedPriceData = ZxPriceSchema.safeParse(priceData);
    if (!validatedPriceData.success) {
      console.warn("⚠️  Invalid price response format:", validatedPriceData.error);
      return null;
    }
    
    if (!validatedPriceData.data.buyAmount) {
      return null;
    }

    // 2. Quote取得（実際の取引用）
    const quoteParams = new URLSearchParams({
      sellToken: fromToken,
      buyToken: toToken,
      sellAmount: amount.toString(),
      takerAddress: BALANCER_FLASH_ARB,
      slippagePercentage: (CONFIG.EXECUTION.MAX_SLIPPAGE / 100).toString(),
      // TODO: Permit2期限付き承認を有効化
      // permitDetails: JSON.stringify({
      //   asset: fromToken,
      //   amount: amount.toString(),
      //   expiration: Math.floor(Date.now() / 1000) + 600, // 10分
      //   nonce: 0
      // })
    });
    
    const quoteUrl = provider.buildQuoteUrl(quoteParams);
    const quoteResponse = await fetchWithRateLimit(
      quoteUrl,
      {
        headers: provider.headers,
      }
    );
    
    if (!quoteResponse.ok) {
      return null;
    }
    
    const quoteData = await quoteResponse.json();
    
    // Zodバリデーション
    const validatedQuoteData = ZxQuoteSchema.safeParse(quoteData);
    if (!validatedQuoteData.success) {
      console.warn("⚠️  Invalid quote response format:", validatedQuoteData.error);
      return null;
    }
    
    if (!validatedQuoteData.data.data || !validatedQuoteData.data.to) {
      return null;
    }

    // 1inch APIの場合はestimatedGasが無いので固定値を設定
    let estimatedGas = validatedQuoteData.data.estimatedGas;
    if (provider.name === '1inch' && !estimatedGas) {
      estimatedGas = "200000"; // 1inch用の固定ガス見積もり（20万ガス）
    }

    return {
      toAmount: BigInt(validatedPriceData.data.buyAmount),
      calldata: validatedQuoteData.data.data,
      target: validatedQuoteData.data.to,
      allowanceTarget: validatedQuoteData.data.allowanceTarget || validatedQuoteData.data.to,
      estimatedGas: estimatedGas
    };
  } catch (error) {
    return null;
  }
}

// 単一パスのアービトラージチェック
async function checkArbitragePath(path: ArbPath, gasPriceGwei: number): Promise<{
  path: ArbPath;
  opportunity?: {
    firstSwap: { toAmount: bigint; calldata: string; target: string; allowanceTarget: string; estimatedGas?: string };
    secondSwap: { toAmount: bigint; calldata: string; target: string; allowanceTarget: string; estimatedGas?: string };
    profitUSD: number;
    percentage: number;
    minPercentage: number;
  };
  error?: string;
}> {
  try {
    // 1. 借りたトークンをターゲットトークンにスワップ
    const firstSwap = await checkSwapPath(
      path.borrowToken,
      path.targetToken,
      path.borrowAmount
    );
    
    if (!firstSwap) {
      return { path, error: "First swap failed" };
    }

    // 2. ターゲットトークンを借りたトークンに戻す
    const secondSwap = await checkSwapPath(
      path.targetToken,
      path.borrowToken,
      firstSwap.toAmount
    );
    
    if (!secondSwap) {
      return { path, error: "Second swap failed" };
    }

    // 3. 利益計算（USD建て）
    const tokenPrice = await getTokenPriceUSDCached(path.borrowToken);
    const { profitUSD, percentage } = calculateProfitUSD(
      path.borrowAmount,
      secondSwap.toAmount,
      path.borrowDecimals,
      tokenPrice
    );

    // 3.1. スリッページチェック
    if (!checkSlippage(path.borrowAmount, secondSwap.toAmount, 0.5)) {
      return { path, error: "Slippage too high" };
    }

    // 4. 動的な最小利益率を計算
    const borrowAmountUSD = Number(ethers.formatUnits(path.borrowAmount, path.borrowDecimals)) * tokenPrice;
    const minPercentage = await calculateMinProfitPercentage(
      gasPriceGwei,
      borrowAmountUSD,
      firstSwap,
      secondSwap
    );
    
    return {
      path,
      opportunity: {
        firstSwap,
        secondSwap,
        profitUSD,
        percentage,
        minPercentage
      }
    };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}

// アービトラージ機会をチェック（並列処理で高速化）
async function checkArbitrage() {
  const timestamp = new Date().toISOString();
  console.log(`🔍 [${timestamp.slice(11, 19)}] Scanning...`);
  
  const startTime = Date.now();
  
  // 現在のガス価格を取得
  const feeData = await currentProvider.getFeeData();
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
  
  if (!gasPrice) {
    console.warn("⚠️  Failed to get gas price, using default 20 Gwei");
    return; // ガス価格が取得できない場合はスキップ
  }
  
  const gasPriceGwei = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));
  
  // ETH価格を取得
  const ethPrice = await getETHPriceUSDCached();
  
  // メトリクス更新
  updateMetrics({
    gasPrice: gasPriceGwei,
    ethPrice: ethPrice,
    avgGasCost: STATE.avgGasUSD
  });
  
  // 並列処理で全パスをチェック
  const results = await Promise.all(
    getArbPaths().map(path => checkArbitragePath(path, gasPriceGwei))
  );
  
  let opportunitiesFound = 0;
  
  for (const result of results) {
    if (result.opportunity) {
      const { path, opportunity } = result;
      const { firstSwap, secondSwap, profitUSD, percentage, minPercentage } = opportunity;
      
      if (percentage > minPercentage) {
        opportunitiesFound++;
        console.log(`\n🎯 ARBITRAGE OPPORTUNITY!`);
        console.log(`📊 ${path.name}: ${percentage.toFixed(3)}% (threshold: ${minPercentage.toFixed(3)}%)`);
        
        // トークン名を正しく表示
        const borrowTokenName = path.borrowToken === USDC ? 'USDC' : 
                               path.borrowToken === DAI ? 'DAI' : 
                               path.borrowToken === USDT ? 'USDT' :
                               path.borrowToken === WETH ? 'WETH' :
                               path.borrowToken === WBTC ? 'WBTC' : 'UNKNOWN';
        
        console.log(`💰 Borrowing: ${ethers.formatUnits(path.borrowAmount, path.borrowDecimals)} ${borrowTokenName}`);
        
        console.log(`💵 Expected profit: $${profitUSD.toFixed(2)}`);
        console.log(`⛽ Gas: ${gasPriceGwei.toFixed(2)} Gwei`);
        
        // メトリクス更新
        updateMetrics({
          profitPercentage: percentage
        });
        
        if (IS_TEST_MODE) {
          console.log(`⚠️  TEST MODE - monitoring only`);
        } else {
          // 実際のアービトラージ実行
          await executeArbitrage(path, firstSwap, secondSwap, profitUSD);
        }
      } else {
        // マイナス利益は簡潔に表示（1行のみ）
        console.log(`📉 ${path.name}: ${percentage.toFixed(3)}% (below ${minPercentage.toFixed(3)}%)`);
      }
    } else if (result.error) {
      // エラーは簡潔に
      console.log(`❌ ${result.path.name}: ${result.error}`);
    }
  }
  
  // メトリクス更新
  updateMetrics({
    activeOpportunities: opportunitiesFound,
    executionTime: (Date.now() - startTime) / 1000
  });
  
  // サマリー表示（簡潔に）
  if (opportunitiesFound > 0) {
    console.log(`\n🎉 Found ${opportunitiesFound}/${results.length} opportunities!`);
  }
}

// アービトラージを実際に実行
async function executeArbitrage(
  path: ArbPath,
  firstSwap: { toAmount: bigint; calldata: string; target: string; allowanceTarget: string; estimatedGas?: string },
  secondSwap: { toAmount: bigint; calldata: string; target: string; allowanceTarget: string; estimatedGas?: string },
  expectedProfitUSD: number
) {
  try {
    console.log(`🚀 Executing ${path.name}...`);
    
    // 事前チェック：スリッページ再確認
    if (!checkSlippage(path.borrowAmount, secondSwap.toAmount)) {
      console.log(`⚠️  Slippage check failed, aborting`);
      return;
    }
    
    // ガス価格チェック
    const feeData = await currentProvider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    
    if (!gasPrice) {
      console.error("❌ Failed to get gas price");
      return;
    }

    const gasPriceGwei = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));
    
    if (gasPriceGwei > CONFIG.GAS.MAX_PRICE_GWEI) {
      console.log(`⚠️  Gas too high: ${gasPriceGwei.toFixed(2)} Gwei`);
      return;
    }

    // 利益がガス代を十分上回るかチェック（USD建て統一）
    const ethPriceUSD = await getETHPriceUSDCached();
    
    // 実際のガス見積もりを使用
    let totalGasEstimate = Number(CONFIG.GAS.LIMIT);
    if (firstSwap.estimatedGas && secondSwap.estimatedGas) {
      const gas1 = parseInt(firstSwap.estimatedGas);
      const gas2 = parseInt(secondSwap.estimatedGas);
      totalGasEstimate = gas1 + gas2 + 100000; // フラッシュローンオーバーヘッド
    }
    
    const estimatedGasCost = totalGasEstimate * gasPriceGwei / 1e9 * ethPriceUSD;
    
    if (expectedProfitUSD < estimatedGasCost * 2) {
      console.log(`⚠️  Profit too low vs gas cost: $${expectedProfitUSD.toFixed(2)} < $${(estimatedGasCost * 2).toFixed(2)}`);
      return;
    }

    console.log(`💰 Expected: $${expectedProfitUSD.toFixed(2)} | Gas: $${estimatedGasCost.toFixed(2)}`);

    // minProfitBpsをUSD相当分に計算
    const tokenPrice = await getTokenPriceUSDCached(path.borrowToken);
    const borrowAmountUSD = Number(ethers.formatUnits(path.borrowAmount, path.borrowDecimals)) * tokenPrice;
    const minProfitBps = calculateMinProfitBpsFromUSD(expectedProfitUSD, borrowAmountUSD);
    
    // 新しい形式でuserDataを作成：[allowanceTarget1, data1, allowanceTarget2, data2]
    const userData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes", "address", "bytes"],
      [firstSwap.allowanceTarget, firstSwap.calldata, secondSwap.allowanceTarget, secondSwap.calldata]
    );
    
    // Priority Fee上限チェック（EIP-1559対応）
    const maxFeeGwei = Number(ethers.formatUnits(feeData.maxFeePerGas || BigInt(0), 'gwei'));
    
    // baseFeeの取得（ethers v6では直接取得できないため、推定値を使用）
    const baseFeeGwei = feeData.maxFeePerGas && feeData.maxPriorityFeePerGas ?
      Number(ethers.formatUnits(feeData.maxFeePerGas - feeData.maxPriorityFeePerGas, 'gwei')) :
      Number(ethers.formatUnits(feeData.gasPrice || BigInt(0), 'gwei')); // フォールバック
    
    // priorityFee ≤ maxFee - baseFee を確実に守る
    const maxPriorityGwei = Math.max(0, maxFeeGwei - baseFeeGwei);
    const priorityFeeGwei = Math.min(gasPriceGwei * 2, maxPriorityGwei * 0.9);
    
    // MEV保護：高い優先料金で送信
    const mevProtectedTx = await currentFlashArb.executeFlashLoan(
      [path.borrowToken],
      [path.borrowAmount],
      minProfitBps,
      userData,
      {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: ethers.parseUnits(priorityFeeGwei.toFixed(1), 'gwei'),
        gasLimit: BigInt(totalGasEstimate) // 実際のガス見積もりを使用
      }
    );
    
    console.log(`🚀 TX: ${mevProtectedTx.hash}`);
    
    // トランザクション数をカウント
    STATE.totalTransactions++;
    
    const receipt = await mevProtectedTx.wait();
    
    if (receipt.status === 1) {
      STATE.successfulTransactions++; // 成功カウント
      console.log(`✅ Success! Block: ${receipt.blockNumber}`);
      console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);
      
      // 実際の利益を計算（ガス代を差し引く）
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const ethPriceUSD = await getETHPriceUSDCached(); // 統一されたETH価格を使用
      const gasCostUSD = Number(gasUsed) / 1e18 * ethPriceUSD;
      
      const netProfit = expectedProfitUSD - gasCostUSD;
      console.log(`💵 Net profit: $${netProfit.toFixed(2)}`);
      
      // 成功率の追跡
      STATE.totalProfit += netProfit;
      console.log(`📊 Total profit: $${STATE.totalProfit.toFixed(2)}`);
      
      // 自動引き出しチェック
      await autoWithdraw();
      
      // ガス履歴の更新
      updateGasHistory(receipt.gasUsed, receipt.gasPrice || BigInt(0), ethPriceUSD, receipt.blockNumber);
      
    } else {
      console.log(`❌ Transaction failed`);
    }
    
  } catch (error) {
    console.error(`❌ Execution failed:`, error instanceof Error ? error.message : String(error));
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
      // 3ブロックごとにスキャン
      if (blockNumber % CONFIG.MONITORING.BLOCK_INTERVAL === 0) {
        STATE.lastBlockNumber = blockNumber;
        
        // パフォーマンス統計を定期的に表示
        if (blockNumber % 30 === 0) { // 10分ごと（30ブロック）
          displayPerformanceStats();
        }
        
        await checkArbitrage();
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
  console.log(`⚙️  Min Profit: ${IS_FORK_ENVIRONMENT ? FORK_CONFIG.PROFIT.MIN_PERCENTAGE : CONFIG.PROFIT.MIN_PERCENTAGE}% | Mode: ${IS_TEST_MODE ? "TEST" : "LIVE"}`);
  
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

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});