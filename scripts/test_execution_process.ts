import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

// 設定
const RPC_URL = process.env.MAINNET_RPC || process.env.ALCHEMY_WSS?.replace('wss://', 'https://');
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const BALANCER_FLASH_ARB = process.env.BALANCER_FLASH_ARB!;
const ZX_API_KEY = process.env.ZX_API_KEY!;

// 0x API レスポンスの型定義
interface ZxQuoteResponse {
  buyAmount: string;
  sellAmount: string;
  allowanceTarget?: string;
  to?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  estimatedGas?: string;
  // v2 API の新しい形式
  transaction?: {
    to: string;
    data: string;
    gas?: string;
    gasPrice?: string;
  };
  permit2?: {
    eip712: {
      domain: {
        verifyingContract: string;
      };
    };
  };
}

interface ZxPriceResponse {
  buyAmount: string;
  sellAmount: string;
  price?: string;
  guaranteedPrice?: string;
}

// コントラクトABI
const abi = [
  "function executeFlashLoan(address[] tokens, uint256[] amounts, uint256 minProfitBps, bytes userData) external",
  "function owner() view returns (address)",
  "function getETHPriceUSD() external returns (uint256)"
];

// トークンアドレス
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

async function test0xAPI() {
  console.log("🔍 0x API接続テスト");
  
  try {
    // Price API テスト
    const priceUrl = `https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${USDC}&buyToken=${WETH}&sellAmount=1000000000`;
    const priceResponse = await fetch(priceUrl, {
      headers: {
        '0x-api-key': ZX_API_KEY,
        '0x-version': 'v2'
      }
    });
    
    console.log(`📡 Price API Status: ${priceResponse.status}`);
    
    if (priceResponse.ok) {
      const priceData = await priceResponse.json() as ZxPriceResponse;
      console.log(`✅ Price API成功: buyAmount=${priceData.buyAmount}`);
    } else {
      const errorData = await priceResponse.text();
      console.log(`❌ Price APIエラー: ${errorData}`);
      return false;
    }
    
    // Quote API テスト
    const quoteUrl = `https://api.0x.org/swap/permit2/quote?chainId=1&sellToken=${USDC}&buyToken=${WETH}&sellAmount=1000000000&taker=${BALANCER_FLASH_ARB}&slippagePercentage=0.01`;
    const quoteResponse = await fetch(quoteUrl, {
      headers: {
        '0x-api-key': ZX_API_KEY,
        '0x-version': 'v2'
      }
    });
    
    console.log(`📡 Quote API Status: ${quoteResponse.status}`);
    
    if (quoteResponse.ok) {
      const quoteData = await quoteResponse.json() as ZxQuoteResponse;
      console.log(`✅ Quote API成功:`);
      console.log(`   - buyAmount: ${quoteData.buyAmount}`);
      console.log(`   - allowanceTarget: ${quoteData.allowanceTarget || quoteData.permit2?.eip712?.domain?.verifyingContract || 'N/A'}`);
      console.log(`   - to: ${quoteData.to || quoteData.transaction?.to || 'N/A'}`);
      console.log(`   - data: ${quoteData.data || quoteData.transaction?.data ? 'Present' : 'N/A'}`);
      return true;
    } else {
      const errorData = await quoteResponse.text();
      console.log(`❌ Quote APIエラー: ${errorData}`);
      return false;
    }
    
  } catch (error) {
    console.log(`❌ API接続エラー: ${error}`);
    return false;
  }
}

async function testContractExecution() {
  console.log("\n🧪 コントラクト実行テスト");
  
  if (!RPC_URL) {
    console.log("❌ RPC URLが設定されていません");
    return false;
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const flashArb = new ethers.Contract(BALANCER_FLASH_ARB, abi, wallet);
  
  try {
    // 基本情報確認
    const owner = await flashArb.owner();
    const balance = await provider.getBalance(wallet.address);
    
    console.log(`✅ コントラクトオーナー: ${owner}`);
    console.log(`✅ ウォレット残高: ${ethers.formatEther(balance)} ETH`);
    console.log(`✅ ウォレットアドレス: ${wallet.address}`);
    
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.log(`❌ オーナー権限なし: 実行テストをスキップ`);
      return false;
    }
    
    // 実際の0x APIデータを取得してテスト
    console.log("\n📡 実際の0x APIデータでテスト");
    
    const sellAmount = ethers.parseUnits("100", 6); // 100 USDC
    
    // 1. 最初のスワップ（USDC -> WETH）
    const firstQuoteUrl = `https://api.0x.org/swap/permit2/quote?chainId=1&sellToken=${USDC}&buyToken=${WETH}&sellAmount=${sellAmount.toString()}&taker=${BALANCER_FLASH_ARB}&slippagePercentage=0.01`;
    const firstResponse = await fetch(firstQuoteUrl, {
      headers: {
        '0x-api-key': ZX_API_KEY,
        '0x-version': 'v2'
      }
    });
    
    if (!firstResponse.ok) {
      console.log(`❌ 最初のスワップAPI失敗: ${await firstResponse.text()}`);
      return false;
    }
    
    const firstQuote = await firstResponse.json() as ZxQuoteResponse;
    console.log(`✅ 最初のスワップ: ${ethers.formatUnits(sellAmount, 6)} USDC -> ${ethers.formatEther(firstQuote.buyAmount)} WETH`);
    
    // 2. 2番目のスワップ（WETH -> USDC）
    const secondQuoteUrl = `https://api.0x.org/swap/permit2/quote?chainId=1&sellToken=${WETH}&buyToken=${USDC}&sellAmount=${firstQuote.buyAmount}&taker=${BALANCER_FLASH_ARB}&slippagePercentage=0.01`;
    const secondResponse = await fetch(secondQuoteUrl, {
      headers: {
        '0x-api-key': ZX_API_KEY,
        '0x-version': 'v2'
      }
    });
    
    if (!secondResponse.ok) {
      console.log(`❌ 2番目のスワップAPI失敗: ${await secondResponse.text()}`);
      return false;
    }
    
    const secondQuote = await secondResponse.json() as ZxQuoteResponse;
    console.log(`✅ 2番目のスワップ: ${ethers.formatEther(firstQuote.buyAmount)} WETH -> ${ethers.formatUnits(secondQuote.buyAmount, 6)} USDC`);
    
    // 利益計算
    const profit = BigInt(secondQuote.buyAmount) - sellAmount;
    const profitPercent = (Number(profit) / Number(sellAmount)) * 100;
    console.log(`💰 理論利益: ${ethers.formatUnits(profit, 6)} USDC (${profitPercent.toFixed(4)}%)`);
    
    // userDataを構築
    const allowanceTarget1 = firstQuote.allowanceTarget || firstQuote.permit2?.eip712?.domain?.verifyingContract || '0x000000000022d473030f116ddee9f6b43ac78ba3';
    const target1 = firstQuote.to || firstQuote.transaction?.to;
    const data1 = firstQuote.data || firstQuote.transaction?.data || '0x';
    
    const allowanceTarget2 = secondQuote.allowanceTarget || secondQuote.permit2?.eip712?.domain?.verifyingContract || '0x000000000022d473030f116ddee9f6b43ac78ba3';
    const target2 = secondQuote.to || secondQuote.transaction?.to;
    const data2 = secondQuote.data || secondQuote.transaction?.data || '0x';

    if (!target1 || !target2) {
      console.log(`❌ 必要なスワップターゲットが取得できません: target1=${target1}, target2=${target2}`);
      return false;
    }

    console.log(`🔧 スワップデータ:`);
    console.log(`   - allowanceTarget1: ${allowanceTarget1}`);
    console.log(`   - target1: ${target1}`);
    console.log(`   - allowanceTarget2: ${allowanceTarget2}`);
    console.log(`   - target2: ${target2}`);

    const userData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes", "address", "address", "bytes"],
      [
        allowanceTarget1,
        target1,
        data1,
        allowanceTarget2,
        target2,
        data2
      ]
    );
    
    // Static callでシミュレーション
    console.log("\n🧪 Static Call シミュレーション");
    try {
      await flashArb.executeFlashLoan.staticCall(
        [USDC],
        [sellAmount],
        Math.max(10, Math.floor(profitPercent * 100 * 0.8)), // 利益の80%を最小利益として設定
        userData
      );
      console.log(`✅ シミュレーション成功: 実際の取引が可能です`);
      return true;
    } catch (error: any) {
      console.log(`❌ シミュレーション失敗: ${error.message}`);
      
      // エラーの詳細分析
      if (error.message.includes("InsufficientProfit")) {
        console.log(`💡 利益不足: より大きな金額または異なるペアを試してください`);
      } else if (error.message.includes("SwapFailed")) {
        console.log(`💡 スワップ失敗: 流動性不足または価格変動の可能性`);
      } else if (error.message.includes("UntrustedSpender")) {
        console.log(`💡 信頼できないスワップターゲット: コントラクト設定を確認してください`);
      }
      return false;
    }
    
  } catch (error) {
    console.log(`❌ コントラクトテストエラー: ${error}`);
    return false;
  }
}

async function main() {
  console.log("🚀 === アービトラージ実行プロセス完全テスト ===\n");
  
  // 1. 0x API接続テスト
  const apiSuccess = await test0xAPI();
  
  if (!apiSuccess) {
    console.log("\n❌ 0x API接続に問題があります。APIキーまたは設定を確認してください。");
    process.exit(1);
  }
  
  // 2. コントラクト実行テスト
  const contractSuccess = await testContractExecution();
  
  console.log("\n🎉 === テスト結果サマリー ===");
  console.log(`📡 0x API接続: ${apiSuccess ? '✅ 成功' : '❌ 失敗'}`);
  console.log(`🔧 コントラクト実行: ${contractSuccess ? '✅ 成功' : '❌ 失敗'}`);
  
  if (apiSuccess && contractSuccess) {
    console.log("\n🚀 すべてのテストが成功しました！実際のアービトラージ実行の準備ができています。");
  } else {
    console.log("\n⚠️  一部のテストが失敗しました。問題を解決してから本番実行してください。");
  }
}

main().catch(console.error); 