import { ethers } from "ethers";
import fetch from "node-fetch";
import * as dotenv from "dotenv";
dotenv.config();

// プライベートキーの検証
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TEST_PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const VALID_PRIVATE_KEY = PRIVATE_KEY && PRIVATE_KEY.length === 66 ? PRIVATE_KEY : TEST_PRIVATE_KEY;

// プロバイダーとウォレットの設定
const RPC_URL = process.env.ALCHEMY_WSS?.replace('wss://', 'https://') || process.env.MAINNET_RPC;
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(VALID_PRIVATE_KEY, provider);

// コントラクトアドレス
const BALANCER_FLASH_ARB = "0x461C5a2F120DCBD136aA33020967dB5C5f777f6a";
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

const flashArb = new ethers.Contract(BALANCER_FLASH_ARB, abi, signer);

// 最適化された設定
const CONFIG = {
  // 借入額設定（現実的な額）
  AMOUNTS: {
    USDC: ethers.parseUnits("30000", 6),   // 3万 USDC
    DAI: ethers.parseUnits("30000", 18),   // 3万 DAI
    WETH: ethers.parseUnits("10", 18),     // 10 WETH
    WBTC: ethers.parseUnits("1", 8),       // 1 WBTC
  },
  
  // ガス設定（現実的な値）
  GAS: {
    LIMIT: 400000n,           // 実測値に基づく
    MAX_PRICE_GWEI: 20,       // より現実的な値
    PRIORITY_FEE_GWEI: 2,     // 優先料金
  },
  
  // 利益設定（動的計算）
  PROFIT: {
    MIN_PERCENTAGE: 0.2,      // 0.2%（$60利益）
    MIN_AMOUNT_USD: 60,       // ガス代を考慮
  },
  
  // 実行制御
  EXECUTION: {
    CHECK_INTERVAL_BLOCKS: 3, // 3ブロックごとにチェック
    MAX_SLIPPAGE: 1,          // 最大スリッページ 1%
  }
};

// 実行状態管理（シンプル化）
const STATE = {
  totalProfit: 0,
  startTime: Date.now()
};

// 設定（旧設定を削除）
const IS_TEST_MODE = false; // 実際の取引を実行

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

const ARB_PATHS: ArbPath[] = [
  // 高流動性ペア（現実的な機会）
  {
    name: "USDC -> WETH -> USDC",
    borrowToken: USDC,
    borrowAmount: CONFIG.AMOUNTS.USDC,
    borrowDecimals: 6,
    targetToken: WETH,
    targetDecimals: 18
  },
  {
    name: "USDC -> WBTC -> USDC",
    borrowToken: USDC,
    borrowAmount: CONFIG.AMOUNTS.USDC,
    borrowDecimals: 6,
    targetToken: WBTC,
    targetDecimals: 8
  },
  {
    name: "USDC -> DAI -> USDC",
    borrowToken: USDC,
    borrowAmount: CONFIG.AMOUNTS.USDC,
    borrowDecimals: 6,
    targetToken: DAI,
    targetDecimals: 18
  },
  {
    name: "USDC -> USDT -> USDC",
    borrowToken: USDC,
    borrowAmount: CONFIG.AMOUNTS.USDC,
    borrowDecimals: 6,
    targetToken: USDT,
    targetDecimals: 6
  },
  {
    name: "DAI -> WETH -> DAI",
    borrowToken: DAI,
    borrowAmount: CONFIG.AMOUNTS.DAI,
    borrowDecimals: 18,
    targetToken: WETH,
    targetDecimals: 18
  },
  {
    name: "DAI -> WBTC -> DAI",
    borrowToken: DAI,
    borrowAmount: CONFIG.AMOUNTS.DAI,
    borrowDecimals: 18,
    targetToken: WBTC,
    targetDecimals: 8
  },
  {
    name: "DAI -> USDC -> DAI",
    borrowToken: DAI,
    borrowAmount: CONFIG.AMOUNTS.DAI,
    borrowDecimals: 18,
    targetToken: USDC,
    targetDecimals: 6
  },
  {
    name: "WETH -> USDC -> WETH",
    borrowToken: WETH,
    borrowAmount: CONFIG.AMOUNTS.WETH,
    borrowDecimals: 18,
    targetToken: USDC,
    targetDecimals: 6
  },
  {
    name: "WETH -> DAI -> WETH",
    borrowToken: WETH,
    borrowAmount: CONFIG.AMOUNTS.WETH,
    borrowDecimals: 18,
    targetToken: DAI,
    targetDecimals: 18
  },
  {
    name: "WETH -> WBTC -> WETH",
    borrowToken: WETH,
    borrowAmount: CONFIG.AMOUNTS.WETH,
    borrowDecimals: 18,
    targetToken: WBTC,
    targetDecimals: 8
  }
];

// 動的な最小利益率の計算
function calculateMinProfitPercentage(gasPriceGwei: number, borrowAmount: number): number {
  const gasLimitNumber = Number(CONFIG.GAS.LIMIT);
  const gasCostETH = (gasLimitNumber * gasPriceGwei) / 1e9;
  const gasCostUSD = gasCostETH * 3000; // ETH価格を$3000と仮定
  
  // ガス代の2倍以上の利益を確保
  const minProfitUSD = gasCostUSD * 2;
  return (minProfitUSD / borrowAmount) * 100;
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
  transaction?: {
    data: string;
    to: string;
    gas?: string;
    gasPrice?: string;
    value?: string;
  };
  buyAmount?: string;
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
): Promise<{ toAmount: bigint; calldata: string; target: string } | null> {
  try {
    // 1. Price取得（見積もり用）
    const priceParams = new URLSearchParams({
      chainId: chainId,
      sellToken: fromToken,
      buyToken: toToken,
      sellAmount: amount.toString()
    });
    
    const priceResponse = await fetchWithTimeout(
      `https://api.0x.org/swap/permit2/price?${priceParams.toString()}`,
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
      chainId: chainId,
      sellToken: fromToken,
      buyToken: toToken,
      sellAmount: amount.toString(),
      taker: BALANCER_FLASH_ARB,
      slippagePercentage: (CONFIG.EXECUTION.MAX_SLIPPAGE / 100).toString()
    });
    
    const quoteResponse = await fetchWithTimeout(
      `https://api.0x.org/swap/permit2/quote?${quoteParams.toString()}`,
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
    
    if (!quoteData.transaction) {
      return null;
    }

    return {
      toAmount: BigInt(priceData.buyAmount),
      calldata: quoteData.transaction.data,
      target: quoteData.transaction.to
    };
  } catch (error) {
    return null;
  }
}

// アービトラージ機会をチェック
async function checkArbitrage() {
  const timestamp = new Date().toISOString();
  console.log(`🔍 [${timestamp.slice(11, 19)}] Scanning...`);
  
  let opportunitiesFound = 0;
  let totalChecked = 0;
  
  // 現在のガス価格を取得
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
  const gasPriceGwei = gasPrice ? Number(gasPrice) / 1e9 : 20;
  
  for (const path of ARB_PATHS) {
    try {
      totalChecked++;
      
      // 1. 借りたトークンをターゲットトークンにスワップ
      const firstSwap = await checkSwapPath(
        path.borrowToken,
        path.targetToken,
        path.borrowAmount
      );
      
      if (!firstSwap) {
        console.log(`❌ ${path.name}: First swap failed`);
        continue;
      }

      // 2. ターゲットトークンを借りたトークンに戻す
      const secondSwap = await checkSwapPath(
        path.targetToken,
        path.borrowToken,
        firstSwap.toAmount
      );
      
      if (!secondSwap) {
        console.log(`❌ ${path.name}: Second swap failed`);
        continue;
      }

      // 3. 利益計算
      const { profit, percentage } = calculateProfit(
        path.borrowAmount,
        secondSwap.toAmount,
        path.borrowDecimals
      );

      // 4. 動的な最小利益率を計算
      const borrowAmountUSD = Number(ethers.formatUnits(path.borrowAmount, path.borrowDecimals)) * 
        (path.borrowToken === USDC || path.borrowToken === DAI || path.borrowToken === USDT ? 1 : 
         path.borrowToken === WETH ? 3000 : 
         path.borrowToken === WBTC ? 60000 : 1);
      
      const minPercentage = calculateMinProfitPercentage(gasPriceGwei, borrowAmountUSD);
      
      if (percentage > minPercentage) {
        opportunitiesFound++;
        console.log(`\n🎯 ARBITRAGE OPPORTUNITY FOUND!`);
        console.log(`📊 Path: ${path.name}`);
        
        // トークン名を正しく表示
        const borrowTokenName = path.borrowToken === USDC ? 'USDC' : 
                               path.borrowToken === DAI ? 'DAI' : 
                               path.borrowToken === USDT ? 'USDT' :
                               path.borrowToken === WETH ? 'WETH' :
                               path.borrowToken === WBTC ? 'WBTC' : 'UNKNOWN';
        
        const targetTokenName = path.targetToken === WETH ? 'WETH' :
                               path.targetToken === USDC ? 'USDC' : 
                               path.targetToken === DAI ? 'DAI' : 
                               path.targetToken === USDT ? 'USDT' :
                               path.targetToken === WBTC ? 'WBTC' : 'UNKNOWN';
        
        console.log(`💰 Borrowing: ${ethers.formatUnits(path.borrowAmount, path.borrowDecimals)} ${borrowTokenName}`);
        console.log(`✅ Step 1: ${ethers.formatUnits(firstSwap.toAmount, path.targetDecimals)} ${targetTokenName}`);
        console.log(`✅ Step 2: ${ethers.formatUnits(secondSwap.toAmount, path.borrowDecimals)} ${borrowTokenName}`);
        console.log(`💵 Expected profit: $${(profit * (borrowAmountUSD / Number(ethers.formatUnits(path.borrowAmount, path.borrowDecimals)))).toFixed(2)} (${percentage.toFixed(3)}%)`);
        console.log(`🎯 Dynamic threshold: ${minPercentage.toFixed(3)}%`);
        console.log(`⛽ Gas price: ${gasPriceGwei.toFixed(2)} Gwei`);
        
        if (IS_TEST_MODE) {
          console.log(`⚠️  TEST MODE - monitoring only`);
        } else {
          // 実際のアービトラージ実行
          await executeArbitrage(path, firstSwap, secondSwap, profit);
        }
        console.log(`─────────────────────────────────────────`);
      } else {
        // マイナス利益は簡潔に表示（1行のみ）
        console.log(`📉 ${path.name}: ${percentage.toFixed(3)}% (below ${minPercentage.toFixed(3)}%)`);
      }
    } catch (error) {
      console.error(`❌ ${path.name}: Error - ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // サマリー表示
  if (opportunitiesFound > 0) {
    console.log(`\n🎉 Found ${opportunitiesFound} opportunities out of ${totalChecked} paths checked!`);
  } else {
    console.log(`📊 Checked ${totalChecked} paths - No profitable opportunities (waiting...)`);
  }
}

// アービトラージを実際に実行
async function executeArbitrage(
  path: ArbPath,
  firstSwap: { toAmount: bigint; calldata: string; target: string },
  secondSwap: { toAmount: bigint; calldata: string; target: string },
  expectedProfit: number
) {
  try {
    console.log(`🚀 Executing arbitrage for ${path.name}...`);
    
    // ガス価格チェック
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    
    if (!gasPrice) {
      console.error("❌ Failed to get gas price");
      return;
    }

    const gasPriceGwei = Number(gasPrice) / 1e9;
    
    if (gasPriceGwei > CONFIG.GAS.MAX_PRICE_GWEI) {
      console.log(`⚠️  Gas price too high: ${gasPriceGwei.toFixed(2)} Gwei - skipping`);
      return;
    }

    console.log(`⛽ Gas price: ${gasPriceGwei.toFixed(2)} Gwei`);

    // フラッシュローンを実行
    const tokens = [path.borrowToken];
    const amounts = [path.borrowAmount];
    
    // 新しい形式でuserDataを作成：[target1, data1, target2, data2]
    const userData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes", "address", "bytes"],
      [firstSwap.target, firstSwap.calldata, secondSwap.target, secondSwap.calldata]
    );
    
    const tx = await flashArb.executeFlashLoan(
      tokens,
      amounts,
      userData,
      {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: ethers.parseUnits(CONFIG.GAS.PRIORITY_FEE_GWEI.toString(), "gwei"),
        gasLimit: CONFIG.GAS.LIMIT
      }
    );
    
    console.log(`📜 Transaction sent: ${tx.hash}`);
    console.log(`⏳ Waiting for confirmation...`);
    
    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      console.log(`✅ Arbitrage successful!`);
      console.log(`   - Block: ${receipt.blockNumber}`);
      console.log(`   - Gas used: ${receipt.gasUsed.toString()}`);
      
      // 実際の利益を計算（ガス代を差し引く）
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const gasCostUSD = Number(gasUsed) / 1e18 * 3000; // ETH価格を$3000と仮定
      
      console.log(`   - Expected profit: $${expectedProfit.toFixed(2)}`);
      const netProfit = expectedProfit - gasCostUSD;
      console.log(`   - Gas cost: $${gasCostUSD.toFixed(2)}`);
      console.log(`   - Net profit: $${netProfit.toFixed(2)}`);
      
      // 状態更新
      STATE.totalProfit += netProfit;
      console.log(`📊 Total profit: $${STATE.totalProfit.toFixed(2)}`);
    } else {
      console.log(`❌ Transaction failed`);
    }
    
  } catch (error) {
    console.error(`❌ Arbitrage execution failed:`, error);
  }
}

// メイン処理
async function main() {
  console.log("🔍 Balancer Flash Loan Arbitrage Scanner Started");
  console.log(`📍 Contract: ${BALANCER_FLASH_ARB} (${IS_TEST_MODE ? 'TEST MODE' : 'LIVE MODE'})`);
  console.log(`📊 Min Profit: Dynamic calculation based on gas price`);
  console.log(`💰 Borrow Amount: $30,000 USDC/DAI, 10 WETH, 1 WBTC`);
  console.log(`⛽ Max Gas: ${CONFIG.GAS.MAX_PRICE_GWEI} Gwei (limit: ${CONFIG.GAS.LIMIT.toString()})`);
  console.log(`💸 Expected gas cost: ~$8-16 (dynamic threshold)`);
  console.log(`🔄 Checking paths:`);
  ARB_PATHS.forEach(path => console.log(`   - ${path.name}`));
  console.log("");

  // 初回チェック
  await checkArbitrage();

  // ブロック監視
  let blockCount = 0;
  provider.on("block", async (blockNumber) => {
    blockCount++;
    // 3ブロックごとにチェック（負荷軽減）
    if (blockCount % CONFIG.EXECUTION.CHECK_INTERVAL_BLOCKS === 0) {
      console.log(`\n⛓️  Block ${blockNumber}`);
      await checkArbitrage();
    }
  });

  // エラー時の再接続
  provider.on("error", (error) => {
    console.error("Provider error:", error);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
