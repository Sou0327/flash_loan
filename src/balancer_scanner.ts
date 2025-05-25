import { ethers } from "ethers";
import fetch from "node-fetch";
import * as dotenv from "dotenv";
dotenv.config();

// プロバイダーとウォレットの設定
const provider = new ethers.WebSocketProvider(process.env.ALCHEMY_WSS!);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

// コントラクトアドレス
const BALANCER_FLASH_ARB = process.env.BALANCER_FLASH_ARB!;
const USDC = process.env.USDC || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = process.env.WETH || "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAI = process.env.DAI || "0x6B175474E89094C44Da98b954EedeAC495271d0F";

// ABI
const abi = [
  "function executeFlashLoan(address[] tokens, uint256[] amounts, bytes userData) external",
  "function owner() view returns (address)",
  "function withdraw(address token) external"
];

const flashArb = new ethers.Contract(BALANCER_FLASH_ARB, abi, signer);

// 設定
const AMOUNT_USDC = ethers.parseUnits("100000", 6); // 10万 USDC
const AMOUNT_DAI = ethers.parseUnits("100000", 18); // 10万 DAI
const MIN_PROFIT_PERCENTAGE = 0.3; // 最小利益率 0.3%
const MAX_GAS_PRICE_GWEI = 50; // 最大ガス価格 50 Gwei

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
  {
    name: "USDC -> WETH -> USDC",
    borrowToken: USDC,
    borrowAmount: AMOUNT_USDC,
    borrowDecimals: 6,
    targetToken: WETH,
    targetDecimals: 18
  },
  {
    name: "DAI -> WETH -> DAI",
    borrowToken: DAI,
    borrowAmount: AMOUNT_DAI,
    borrowDecimals: 18,
    targetToken: WETH,
    targetDecimals: 18
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
      sellAmount: amount.toString(),
      taker: BALANCER_FLASH_ARB
    });
    
    const priceResponse = await fetch(
      `https://api.0x.org/swap/permit2/price?${priceParams.toString()}`,
      {
        headers: { 
          '0x-api-key': apiKey,
          '0x-version': 'v2'
        },
      }
    );
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
      slippagePercentage: '0.01' // 1%スリッページ
    });
    
    const quoteResponse = await fetch(
      `https://api.0x.org/swap/permit2/quote?${quoteParams.toString()}`,
      {
        headers: { 
          '0x-api-key': apiKey,
          '0x-version': 'v2'
        },
      }
    );
    const quoteData = await quoteResponse.json() as ZxQuoteResponse;
    
    if (!quoteData.transaction) {
      return null;
    }

    return {
      toAmount: BigInt(priceData.buyAmount),
      calldata: quoteData.transaction.data
    };
  } catch (error) {
    console.error(`Error checking swap path: ${error}`);
    return null;
  }
}

// アービトラージ機会をチェック
async function checkArbitrage() {
  const timestamp = new Date().toISOString();
  
  for (const path of ARB_PATHS) {
    try {
      // 1. 借りたトークンをターゲットトークンにスワップ
      const firstSwap = await checkSwapPath(
        path.borrowToken,
        path.targetToken,
        path.borrowAmount
      );
      
      if (!firstSwap) continue;

      // 2. ターゲットトークンを借りたトークンに戻す
      const secondSwap = await checkSwapPath(
        path.targetToken,
        path.borrowToken,
        firstSwap.toAmount
      );
      
      if (!secondSwap) continue;

      // 3. 利益計算（Balancerの手数料は無料）
      const { profit, percentage } = calculateProfit(
        path.borrowAmount,
        secondSwap.toAmount,
        path.borrowDecimals
      );

      console.log(`[${timestamp}] ${path.name}: Profit: $${profit.toFixed(2)} (${percentage.toFixed(3)}%)`);

      // 4. 利益が閾値を超えていればアービトラージ実行
      if (percentage > MIN_PROFIT_PERCENTAGE) {
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
        
        if (!gasPrice) {
          console.error("Failed to get gas price");
          continue;
        }

        const gasPriceGwei = Number(gasPrice) / 1e9;
        
        if (gasPriceGwei > MAX_GAS_PRICE_GWEI) {
          console.log(`⚠️  Gas price too high: ${gasPriceGwei.toFixed(2)} Gwei`);
          continue;
        }

        console.log(`🎯 Arbitrage opportunity found!`);
        console.log(`   - Path: ${path.name}`);
        console.log(`   - Expected profit: $${profit.toFixed(2)} (${percentage.toFixed(3)}%)`);
        console.log(`   - Gas price: ${gasPriceGwei.toFixed(2)} Gwei`);

        // フラッシュローンを実行
        const tokens = [path.borrowToken];
        const amounts = [path.borrowAmount];
        
        // 2つのスワップを組み合わせたcalldataを作成
        // 注: 実際の実装では、コントラクト内で2つのスワップを実行する必要があります
        const tx = await flashArb.executeFlashLoan(
          tokens,
          amounts,
          firstSwap.calldata, // 簡略化のため、最初のスワップのみ
          {
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            gasLimit: 600000n
          }
        );
        
        console.log(`📜 Transaction sent: ${tx.hash}`);
        
        const receipt = await tx.wait();
        console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
      }
    } catch (error) {
      console.error(`Error checking ${path.name}:`, error);
    }
  }
}

// メイン処理
async function main() {
  console.log("🔍 Balancer Flash Loan Arbitrage Scanner Started");
  console.log(`📍 Contract: ${BALANCER_FLASH_ARB}`);
  console.log(`📊 Min Profit: ${MIN_PROFIT_PERCENTAGE}%`);
  console.log(`⛽ Max Gas: ${MAX_GAS_PRICE_GWEI} Gwei`);
  console.log(`🔄 Checking paths:`);
  ARB_PATHS.forEach(path => console.log(`   - ${path.name}`));
  console.log("");

  // オーナー確認
  const owner = await flashArb.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.error("❌ You are not the owner of the contract!");
    return;
  }

  // 初回チェック
  await checkArbitrage();

  // ブロック監視
  let blockCount = 0;
  provider.on("block", async (blockNumber) => {
    blockCount++;
    // 5ブロックごとにチェック（負荷軽減）
    if (blockCount % 5 === 0) {
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