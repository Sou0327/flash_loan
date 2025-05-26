import { ethers } from "ethers";
import fetch from "node-fetch";
import * as dotenv from "dotenv";
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
  "function executeFlashLoan(address[] tokens, uint256[] amounts, bytes userData) external",
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
    LIMIT: 400000n,           // 実測値に基づく
    MAX_PRICE_GWEI: 25,       // 少し高めに調整
    PRIORITY_FEE_GWEI: 1.5,   // MEV保護用の優先料金
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
};

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
    // 0x API v2から価格を取得
    const response = await fetchWithTimeout(
      `https://api.0x.org/swap/v2/price?sellToken=${tokenAddress}&buyToken=${USDC}&sellAmount=1000000000000000000`,
      {
        headers: { 
          '0x-api-key': apiKey,
          '0x-version': 'v2'
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
    // 0x API v2でETH/USDC価格を取得
    const response = await fetchWithTimeout(
      `https://api.0x.org/swap/v2/price?sellToken=${WETH}&buyToken=${USDC}&sellAmount=1000000000000000000`,
      {
        headers: { 
          '0x-api-key': apiKey,
          '0x-version': 'v2'
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
  maxSlippagePercent: number = 0.5
): boolean {
  const slippage = Number(borrowAmount - returnAmount) / Number(borrowAmount) * 100;
  return Math.abs(slippage) <= maxSlippagePercent;
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
  let totalGasEstimate = Number(CONFIG.GAS.LIMIT);
  
  if (firstSwap?.estimatedGas && secondSwap?.estimatedGas) {
    const gas1 = parseInt(firstSwap.estimatedGas);
    const gas2 = parseInt(secondSwap.estimatedGas);
    // フラッシュローンのオーバーヘッドを追加（約100,000ガス）
    totalGasEstimate = gas1 + gas2 + 100000;
  }
  
  const gasCostETH = (totalGasEstimate * gasPriceGwei) / 1e9;
  const gasCostUSD = gasCostETH * ethPriceUSD;
  
  // ガス代の2倍以上の利益を確保
  const minProfitUSD = gasCostUSD * 2;
  const calculatedPercentage = (minProfitUSD / borrowAmountUSD) * 100;
  
  // 最小0.2%、最大2%の範囲に制限（より現実的）
  return Math.max(0.2, Math.min(2.0, calculatedPercentage));
}

// 利益計算
function calculateProfit(
  borrowAmount: bigint,
  returnAmount: bigint,
  borrowDecimals: number
): { profit: number; percentage: number } {
  const borrowed = Number(borrowAmount) / (10 ** borrowDecimals);
  const returned = Number(returnAmount) / (10 ** borrowDecimals);
  const profit = returned - borrowed;
  const percentage = (profit / borrowed) * 100;
  return { profit, percentage };
}

// 0x Protocol APIレスポンスの型定義
interface ZxPriceResponse {
  buyAmount?: string;
  sellAmount?: string;
  [key: string]: any;
}

interface ZxQuoteResponse {
  data?: string;
  to?: string;
  allowanceTarget?: string;
  estimatedGas?: string;
  [key: string]: any;
}

// タイムアウト付きfetch
async function fetchWithTimeout(url: string, options: any): Promise<any> {
  try {
    const response = await fetch(url, {
      ...options
    });
    return response;
  } catch (error) {
    throw error;
  }
}

// 0x Protocol APIでスワップパスをチェック
async function checkSwapPath(
  fromToken: string,
  toToken: string,
  amount: bigint
): Promise<{ toAmount: bigint; calldata: string; target: string; allowanceTarget: string; estimatedGas?: string } | null> {
  try {
    const base = "https://api.0x.org/swap/v2";
    
    // 1. Price取得（見積もり用）
    const priceParams = new URLSearchParams({
      sellToken: fromToken,
      buyToken: toToken,
      sellAmount: amount.toString()
    });
    
    const priceResponse = await fetchWithTimeout(
      `${base}/price?${priceParams.toString()}`,
      {
        headers: { 
          '0x-api-key': apiKey,
          '0x-version': 'v2'
        },
      }
    );
    
    if (!priceResponse.ok) {
      return null;
    }

    const priceData = await priceResponse.json() as ZxPriceResponse;
    
    if (!priceData.buyAmount) {
      return null;
    }

    // 2. Quote取得（実際の取引用）
    const quoteParams = new URLSearchParams({
      sellToken: fromToken,
      buyToken: toToken,
      sellAmount: amount.toString(),
      takerAddress: BALANCER_FLASH_ARB,
      slippagePercentage: (CONFIG.EXECUTION.MAX_SLIPPAGE / 100).toString()
    });
    
    const quoteResponse = await fetchWithTimeout(
      `${base}/quote?${quoteParams.toString()}`,
      {
        headers: { 
          '0x-api-key': apiKey,
          '0x-version': 'v2'
        },
      }
    );
    
    if (!quoteResponse.ok) {
      return null;
    }
    
    const quoteData = await quoteResponse.json() as ZxQuoteResponse;
    
    if (!quoteData.data || !quoteData.to) {
      return null;
    }

    return {
      toAmount: BigInt(priceData.buyAmount),
      calldata: quoteData.data,
      target: quoteData.to,
      allowanceTarget: quoteData.allowanceTarget || quoteData.to,
      estimatedGas: quoteData.estimatedGas
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
    profit: number;
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

    // 3. 利益計算
    const { profit, percentage } = calculateProfit(
      path.borrowAmount,
      secondSwap.toAmount,
      path.borrowDecimals
    );

    // 3.1. スリッページチェック
    if (!checkSlippage(path.borrowAmount, secondSwap.toAmount, 0.5)) {
      return { path, error: "Slippage too high" };
    }

    // 4. 動的な最小利益率を計算
    const tokenPrice = await getTokenPriceUSDCached(path.borrowToken);
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
        profit,
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
  
  // 現在のガス価格を取得
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
  const gasPriceGwei = gasPrice ? Number(gasPrice) / 1e9 : 20;
  
  // 並列処理で全パスをチェック
  const results = await Promise.all(
    getArbPaths().map(path => checkArbitragePath(path, gasPriceGwei))
  );
  
  let opportunitiesFound = 0;
  
  for (const result of results) {
    if (result.opportunity) {
      const { path, opportunity } = result;
      const { firstSwap, secondSwap, profit, percentage, minPercentage } = opportunity;
      
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
        
        const tokenPrice = await getTokenPriceUSDCached(path.borrowToken);
        const borrowAmountUSD = Number(ethers.formatUnits(path.borrowAmount, path.borrowDecimals)) * tokenPrice;
        console.log(`💵 Expected profit: $${(profit * (borrowAmountUSD / Number(ethers.formatUnits(path.borrowAmount, path.borrowDecimals)))).toFixed(2)}`);
        console.log(`⛽ Gas: ${gasPriceGwei.toFixed(2)} Gwei`);
        
        if (IS_TEST_MODE) {
          console.log(`⚠️  TEST MODE - monitoring only`);
        } else {
          // 実際のアービトラージ実行
          await executeArbitrage(path, firstSwap, secondSwap, profit);
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
  expectedProfit: number
) {
  try {
    console.log(`🚀 Executing ${path.name}...`);
    
    // 事前チェック：スリッページ再確認
    if (!checkSlippage(path.borrowAmount, secondSwap.toAmount, 0.5)) {
      console.log(`⚠️  Slippage check failed, aborting`);
      return;
    }
    
    // ガス価格チェック
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    
    if (!gasPrice) {
      console.error("❌ Failed to get gas price");
      return;
    }

    const gasPriceGwei = Number(gasPrice) / 1e9;
    
    if (gasPriceGwei > CONFIG.GAS.MAX_PRICE_GWEI) {
      console.log(`⚠️  Gas too high: ${gasPriceGwei.toFixed(2)} Gwei`);
      return;
    }

    // 利益がガス代を十分上回るかチェック
    const estimatedGasCost = Number(CONFIG.GAS.LIMIT) * gasPriceGwei / 1e9 * 3000; // USD
    if (expectedProfit < estimatedGasCost * 2) {
      console.log(`⚠️  Profit too low vs gas cost`);
      return;
    }

    console.log(`💰 Expected: $${expectedProfit.toFixed(2)} | Gas: $${estimatedGasCost.toFixed(2)}`);

    // フラッシュローンを実行
    const tokens = [path.borrowToken];
    const amounts = [path.borrowAmount];
    
    // 新しい形式でuserDataを作成：[allowanceTarget1, data1, allowanceTarget2, data2]
    const userData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes", "address", "bytes"],
      [firstSwap.allowanceTarget, firstSwap.calldata, secondSwap.allowanceTarget, secondSwap.calldata]
    );
    
    // MEV保護：優先料金を動的に調整
    const priorityFee = Math.max(
      CONFIG.GAS.PRIORITY_FEE_GWEI,
      gasPriceGwei * 0.1 // ベースガス価格の10%
    );
    
    const tx = await flashArb.executeFlashLoan(
      tokens,
      amounts,
      userData,
      {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: ethers.parseUnits(priorityFee.toString(), "gwei"),
        gasLimit: CONFIG.GAS.LIMIT
      }
    );
    
    console.log(`📜 TX: ${tx.hash}`);
    
    // トランザクション数をカウント
    STATE.totalTransactions++;
    
    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      STATE.successfulTransactions++; // 成功カウント
      console.log(`✅ Success! Block: ${receipt.blockNumber}`);
      console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);
      
      // 実際の利益を計算（ガス代を差し引く）
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const gasCostUSD = Number(gasUsed) / 1e18 * 3000; // ETH価格を$3000と仮定
      
      const netProfit = expectedProfit - gasCostUSD;
      console.log(`💵 Net profit: $${netProfit.toFixed(2)}`);
      
      // 成功率の追跡
      STATE.totalProfit += netProfit;
      console.log(`📊 Total profit: $${STATE.totalProfit.toFixed(2)}`);
      
      // 自動引き出しチェック
      await autoWithdraw();
      
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

async function reconnectProvider(): Promise<void> {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error("❌ Max reconnection attempts reached. Exiting...");
    process.exit(1);
  }
  
  reconnectAttempts++;
  console.log(`🔄 Reconnecting... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  
  await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
  
  try {
    // 新しいプロバイダーを作成
    const newProvider = new ethers.JsonRpcProvider(RPC_URL);
    
    // 接続テスト
    await newProvider.getBlockNumber();
    
    // 成功したら古いプロバイダーを置き換え
    provider.removeAllListeners();
    Object.setPrototypeOf(provider, newProvider);
    
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
  provider.on("error", async (error) => {
    console.error("🔌 Provider error:", error.message);
    await reconnectProvider();
  });
  
  // ブロック監視
  provider.on("block", async (blockNumber) => {
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
  const balance = await provider.getBalance(wallet.address);
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
      provider
    );
    
    const balanceBefore = await tokenContract.balanceOf(BALANCER_FLASH_ARB);
    console.log(`💰 Contract balance before: ${ethers.formatUnits(balanceBefore, 6)} tokens`);
    
    if (balanceBefore === 0n) {
      console.log("⚠️  No tokens to withdraw");
      return;
    }
    
    // 引き出し実行
    const tx = await flashArb.withdraw(AUTO_WITHDRAW_TOKEN);
    console.log(`📜 Withdrawal TX: ${tx.hash}`);
    
    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      // 引き出し後の残高確認
      const balanceAfter = await tokenContract.balanceOf(BALANCER_FLASH_ARB);
      const withdrawnAmount = balanceBefore - balanceAfter;
      
      console.log(`✅ Auto-withdrawal successful!`);
      console.log(`💵 Withdrawn: ${ethers.formatUnits(withdrawnAmount, 6)} tokens`);
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

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});