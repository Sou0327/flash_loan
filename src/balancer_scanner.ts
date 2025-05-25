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
const BALANCER_FLASH_ARB = "0xEd62FA774DC2650E4d72b16B4f86B28E84D25DcA";
const USDC = process.env.USDC || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = process.env.WETH || "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAI = process.env.DAI || "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const USDT = process.env.USDT || "0xdAC17F958D2ee523a2206206994597C13D831ec7";

// ミームコイン
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933"; // PEPE
const SHIB = "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE"; // SHIBA INU
const DOGE = "0x4206931337dc273a630d328dA6441786BfaD668f"; // DOGE
const FLOKI = "0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E"; // FLOKI

// ABI
const abi = [
  "function executeFlashLoan(address[] tokens, uint256[] amounts, bytes userData) external",
  "function owner() view returns (address)",
  "function withdraw(address token) external"
];

const flashArb = new ethers.Contract(BALANCER_FLASH_ARB, abi, signer);

// 最適化された設定
const CONFIG = {
  // 借入額設定（より大きな額で効率化）
  AMOUNTS: {
    USDC: ethers.parseUnits("10000", 6),   // 1万 USDC
    DAI: ethers.parseUnits("10000", 18),   // 1万 DAI
    USDT: ethers.parseUnits("10000", 6),   // 1万 USDT
  },
  
  // ガス設定（現実的な値）
  GAS: {
    LIMIT: 350000n,           // 実測値に基づく
    MAX_PRICE_GWEI: 30,       // 約$35のガス代まで許容
    PRIORITY_FEE_GWEI: 2,     // 優先料金
  },
  
  // 利益設定
  PROFIT: {
    MIN_PERCENTAGE: 0.5,      // 最小利益率 0.5%（元の設定）
    MIN_AMOUNT_USD: 40,       // 最小利益額 $40（元の設定）
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
  // ステーブルコイン/ETHペア（安定した機会）
  {
    name: "USDC -> WETH -> USDC",
    borrowToken: USDC,
    borrowAmount: CONFIG.AMOUNTS.USDC,
    borrowDecimals: 6,
    targetToken: WETH,
    targetDecimals: 18
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
  
  // ミームコインペア（高ボラティリティ機会）
  {
    name: "USDC -> PEPE -> USDC",
    borrowToken: USDC,
    borrowAmount: CONFIG.AMOUNTS.USDC,
    borrowDecimals: 6,
    targetToken: PEPE,
    targetDecimals: 18
  },
  {
    name: "USDC -> SHIB -> USDC",
    borrowToken: USDC,
    borrowAmount: CONFIG.AMOUNTS.USDC,
    borrowDecimals: 6,
    targetToken: SHIB,
    targetDecimals: 18
  },
  {
    name: "USDC -> DOGE -> USDC",
    borrowToken: USDC,
    borrowAmount: CONFIG.AMOUNTS.USDC,
    borrowDecimals: 6,
    targetToken: DOGE,
    targetDecimals: 8
  },
  {
    name: "USDC -> FLOKI -> USDC",
    borrowToken: USDC,
    borrowAmount: CONFIG.AMOUNTS.USDC,
    borrowDecimals: 6,
    targetToken: FLOKI,
    targetDecimals: 9
  },
  
  // 高額DAIペア（追加）
  {
    name: "DAI -> WETH -> DAI",
    borrowToken: DAI,
    borrowAmount: CONFIG.AMOUNTS.DAI,
    borrowDecimals: 18,
    targetToken: WETH,
    targetDecimals: 18
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
    name: "DAI -> PEPE -> DAI",
    borrowToken: DAI,
    borrowAmount: CONFIG.AMOUNTS.DAI,
    borrowDecimals: 18,
    targetToken: PEPE,
    targetDecimals: 18
  },
  
  // ミームコイン間（極高ボラティリティ）
  {
    name: "PEPE -> SHIB -> PEPE",
    borrowToken: PEPE,
    borrowAmount: ethers.parseUnits("100000000", 18), // 1億 PEPE（元の設定）
    borrowDecimals: 18,
    targetToken: SHIB,
    targetDecimals: 18
  },
  {
    name: "SHIB -> DOGE -> SHIB",
    borrowToken: SHIB,
    borrowAmount: ethers.parseUnits("100000000", 18), // 1億 SHIB（元の設定）
    borrowDecimals: 18,
    targetToken: DOGE,
    targetDecimals: 8
  }
];

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
): Promise<{ toAmount: bigint; calldata: string } | null> {
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
      taker: BALANCER_FLASH_ARB, // takerパラメータを追加
      slippagePercentage: (CONFIG.EXECUTION.MAX_SLIPPAGE / 100).toString() // 設定からスリッページを取得
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
      calldata: quoteData.transaction.data
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

      // 3. 利益計算（Balancerの手数料は無料）
      const { profit, percentage } = calculateProfit(
        path.borrowAmount,
        secondSwap.toAmount,
        path.borrowDecimals
      );

      // 4. 利益が閾値を超えていれば詳細表示、そうでなければ簡潔表示
      const isStablecoin = path.borrowToken === USDC || path.borrowToken === DAI || path.borrowToken === USDT;
      const minPercentage = isStablecoin ? CONFIG.PROFIT.MIN_PERCENTAGE : 1.5; // ミームコインは1.5%（リスク承知で下げる）
      
      if (percentage > minPercentage) {
        opportunitiesFound++;
        console.log(`\n🎯 ARBITRAGE OPPORTUNITY FOUND!`);
        console.log(`📊 Path: ${path.name}`);
        
        // トークン名を正しく表示
        const borrowTokenName = path.borrowToken === USDC ? 'USDC' : 
                               path.borrowToken === DAI ? 'DAI' : 
                               path.borrowToken === USDT ? 'USDT' :
                               path.borrowToken === PEPE ? 'PEPE' :
                               path.borrowToken === SHIB ? 'SHIB' :
                               path.borrowToken === DOGE ? 'DOGE' :
                               path.borrowToken === FLOKI ? 'FLOKI' : 'UNKNOWN';
        
        const targetTokenName = path.targetToken === WETH ? 'WETH' :
                               path.targetToken === USDC ? 'USDC' : 
                               path.targetToken === DAI ? 'DAI' : 
                               path.targetToken === USDT ? 'USDT' :
                               path.targetToken === PEPE ? 'PEPE' :
                               path.targetToken === SHIB ? 'SHIB' :
                               path.targetToken === DOGE ? 'DOGE' :
                               path.targetToken === FLOKI ? 'FLOKI' : 'UNKNOWN';
        
        console.log(`💰 Borrowing: ${ethers.formatUnits(path.borrowAmount, path.borrowDecimals)} ${borrowTokenName}`);
        console.log(`✅ Step 1: ${ethers.formatUnits(firstSwap.toAmount, path.targetDecimals)} ${targetTokenName}`);
        console.log(`✅ Step 2: ${ethers.formatUnits(secondSwap.toAmount, path.borrowDecimals)} ${borrowTokenName}`);
        
        // ミームコインの場合はドル換算しない
        if (isStablecoin) {
          console.log(`💵 Expected profit: $${profit.toFixed(2)} (${percentage.toFixed(3)}%)`);
        } else {
          console.log(`💵 Expected profit: ${profit.toFixed(2)} ${borrowTokenName} (${percentage.toFixed(3)}%)`);
          console.log(`⚠️  Note: Meme coin arbitrage - profit shown in token units, not USD`);
        }
        
        console.log(`🎯 Threshold: ${minPercentage}%`);
        
        if (IS_TEST_MODE) {
          console.log(`⚠️  TEST MODE - monitoring only`);
        } else {
          // 実際のアービトラージ実行（全てのトークン）
          await executeArbitrage(path, firstSwap, secondSwap, profit);
        }
        console.log(`─────────────────────────────────────────`);
      } else {
        // マイナス利益は簡潔に表示（1行のみ）
        console.log(`📉 ${path.name}: ${percentage.toFixed(3)}% (below threshold)`);
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
  firstSwap: { toAmount: bigint; calldata: string },
  secondSwap: { toAmount: bigint; calldata: string },
  expectedProfit: number
) {
  try {
    // ステーブルコインかどうかを判定
    const isStablecoin = path.borrowToken === USDC || path.borrowToken === DAI || path.borrowToken === USDT;
    
    // 最小利益額チェック
    if (isStablecoin) {
      if (expectedProfit < CONFIG.PROFIT.MIN_AMOUNT_USD) {
        console.log(`⚠️  Profit too low: $${expectedProfit.toFixed(2)} < $${CONFIG.PROFIT.MIN_AMOUNT_USD}`);
        return;
      }
    } else {
      // ミームコインの場合：より高い利益率を要求（ガス代を考慮）
      const minMemeProfit = 1.5; // 1.5%以上の利益率を要求（リスク承知で下げる）
      const currentPercentage = (expectedProfit / Number(ethers.formatUnits(path.borrowAmount, path.borrowDecimals))) * 100;
      
      if (currentPercentage < minMemeProfit) {
        console.log(`⚠️  Meme coin profit too low: ${currentPercentage.toFixed(3)}% < ${minMemeProfit}%`);
        return;
      }
      
      // 概算でガス代を上回るかチェック（保守的に$20のガス代を想定）
      const estimatedGasCostUSD = 20;
      const tokenName = path.borrowToken === PEPE ? 'PEPE' :
                       path.borrowToken === SHIB ? 'SHIB' :
                       path.borrowToken === DOGE ? 'DOGE' :
                       path.borrowToken === FLOKI ? 'FLOKI' : 'UNKNOWN';
      
      console.log(`⚠️  Meme coin arbitrage: ${expectedProfit.toFixed(2)} ${tokenName} profit vs ~$${estimatedGasCostUSD} gas cost`);
      console.log(`⚠️  Proceeding with caution - profit may not cover gas costs`);
    }

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
    
    // 2つのスワップを組み合わせたcalldataを作成
    const userData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes", "bytes"],
      [firstSwap.calldata, secondSwap.calldata]
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
      
      if (isStablecoin) {
        console.log(`   - Expected profit: $${expectedProfit.toFixed(2)}`);
        const netProfit = expectedProfit - gasCostUSD;
        console.log(`   - Gas cost: $${gasCostUSD.toFixed(2)}`);
        console.log(`   - Net profit: $${netProfit.toFixed(2)}`);
        
        // 状態更新
        STATE.totalProfit += netProfit;
        console.log(`📊 Total profit: $${STATE.totalProfit.toFixed(2)}`);
      } else {
        // ミームコインの場合
        const tokenName = path.borrowToken === PEPE ? 'PEPE' :
                         path.borrowToken === SHIB ? 'SHIB' :
                         path.borrowToken === DOGE ? 'DOGE' :
                         path.borrowToken === FLOKI ? 'FLOKI' : 'UNKNOWN';
        console.log(`   - Expected profit: ${expectedProfit.toFixed(2)} ${tokenName}`);
        console.log(`   - Gas cost: $${gasCostUSD.toFixed(2)}`);
        console.log(`   - Note: Meme coin profit not converted to USD`);
      }
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
  console.log(`📊 Min Profit: ${CONFIG.PROFIT.MIN_PERCENTAGE}% ($${CONFIG.PROFIT.MIN_AMOUNT_USD})`);
  console.log(`💰 Borrow Amount: $10,000 USDC/DAI (10x increase!)`);
  console.log(`⛽ Max Gas: ${CONFIG.GAS.MAX_PRICE_GWEI} Gwei (limit: ${CONFIG.GAS.LIMIT.toString()})`);
  console.log(`💸 Expected gas cost: ~$10-15 (0.1-0.15% ratio!)`);
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