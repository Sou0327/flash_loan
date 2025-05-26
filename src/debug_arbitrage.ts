import { ethers } from "ethers";
import fetch from "node-fetch";
import * as dotenv from "dotenv";
dotenv.config();

// デバッグ用の診断ツール
async function runComprehensiveDiagnostics() {
  console.log("🔧 === アービトラージ診断ツール ===\n");
  
  const results = {
    rpcConnection: false,
    apiConnection: false,
    gasPrice: 0,
    ethPrice: 0,
    tokenPrices: {} as Record<string, number>,
    arbitrageOpportunities: [] as any[],
    configIssues: [] as string[]
  };

  // 1️⃣ 基本設定チェック
  console.log("1️⃣ 基本設定チェック...");
  const requiredEnvVars = ['MAINNET_RPC', 'ZX_API_KEY', 'PRIVATE_KEY'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    results.configIssues.push(`Missing env vars: ${missingVars.join(', ')}`);
    console.log(`❌ 不足している環境変数: ${missingVars.join(', ')}`);
  } else {
    console.log("✅ 環境変数: OK");
  }

  // 2️⃣ RPC接続テスト
  console.log("\n2️⃣ RPC接続テスト...");
  try {
    const provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC);
    const blockNumber = await provider.getBlockNumber();
    const gasData = await provider.getFeeData();
    
    results.rpcConnection = true;
    results.gasPrice = parseFloat(ethers.formatUnits(gasData.gasPrice || BigInt(0), 'gwei'));
    
    console.log(`✅ RPC接続: OK (Block: ${blockNumber})`);
    console.log(`⛽ Current Gas: ${results.gasPrice.toFixed(2)} Gwei`);
  } catch (error) {
    console.log(`❌ RPC接続エラー:`, error);
    results.configIssues.push('RPC connection failed');
  }

  // 3️⃣ 0x API接続テスト
  console.log("\n3️⃣ 0x API接続テスト...");
  try {
    const testResponse = await fetch(
      'https://api.0x.org/swap/permit2/price?chainId=1&sellToken=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&buyToken=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2&sellAmount=1000000',
      {
        headers: {
          '0x-api-key': process.env.ZX_API_KEY!,
          '0x-version': 'v2'
        }
      }
    );

    if (testResponse.ok) {
      const data = await testResponse.json() as any;
      results.apiConnection = true;
      results.ethPrice = Number(data.buyAmount) / 1e6 / 1e12; // USDC(6) -> ETH(18)の変換
      console.log(`✅ 0x API: OK`);
      console.log(`💰 ETH Price: $${(1 / results.ethPrice).toFixed(2)}`);
    } else {
      const errorText = await testResponse.text();
      console.log(`❌ 0x API Error (${testResponse.status}): ${errorText}`);
      results.configIssues.push(`0x API failed: ${testResponse.status}`);
    }
  } catch (error) {
    console.log(`❌ 0x API接続エラー:`, error);
    results.configIssues.push('0x API connection failed');
  }

  // 4️⃣ 主要トークン価格取得テスト
  console.log("\n4️⃣ 主要トークン価格テスト...");
  const tokens = {
    'USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    'WETH': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    'DAI': '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    'WBTC': '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
  };

  for (const [symbol, address] of Object.entries(tokens)) {
    try {
      const response = await fetch(
        `https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${address}&buyToken=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&sellAmount=1000000000000000000`,
        {
          headers: {
            '0x-api-key': process.env.ZX_API_KEY!,
            '0x-version': 'v2'
          }
        }
      );

      if (response.ok) {
        const data = await response.json() as any;
        const price = Number(data.buyAmount) / 1e6; // USDC価格
        results.tokenPrices[symbol] = price;
        console.log(`✅ ${symbol}: $${price.toFixed(2)}`);
      } else {
        console.log(`❌ ${symbol}: API Error ${response.status}`);
      }
      
      // レート制限回避
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.log(`❌ ${symbol}: ${error}`);
    }
  }

  // 5️⃣ 実際のアービトラージ機会テスト（超低利益設定）
  console.log("\n5️⃣ アービトラージ機会診断（超低設定）...");
  
  const testPaths = [
    {
      name: "USDC -> WETH -> USDC",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      midToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "1000000000" // 1000 USDC (6 decimals)
    },
    {
      name: "USDC -> DAI -> USDC", 
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      midToken: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      amount: "1000000000" // 1000 USDC
    }
  ];

  for (const testPath of testPaths) {
    console.log(`\n🔍 Testing: ${testPath.name}`);
    
    try {
      // Step 1: USDC -> MidToken
      const step1Response = await fetch(
        `https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${testPath.fromToken}&buyToken=${testPath.midToken}&sellAmount=${testPath.amount}`,
        {
          headers: {
            '0x-api-key': process.env.ZX_API_KEY!,
            '0x-version': 'v2'
          }
        }
      );

      if (!step1Response.ok) {
        console.log(`   ❌ Step 1 failed: ${step1Response.status}`);
        continue;
      }

      const step1Data = await step1Response.json() as any;
      const midTokenAmount = step1Data.buyAmount;
      console.log(`   ✅ Step 1: ${testPath.amount} -> ${midTokenAmount}`);

      await new Promise(resolve => setTimeout(resolve, 500));

      // Step 2: MidToken -> USDC
      const step2Response = await fetch(
        `https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${testPath.midToken}&buyToken=${testPath.fromToken}&sellAmount=${midTokenAmount}`,
        {
          headers: {
            '0x-api-key': process.env.ZX_API_KEY!,
            '0x-version': 'v2'
          }
        }
      );

      if (!step2Response.ok) {
        console.log(`   ❌ Step 2 failed: ${step2Response.status}`);
        continue;
      }

      const step2Data = await step2Response.json() as any;
      const finalAmount = step2Data.buyAmount;
      console.log(`   ✅ Step 2: ${midTokenAmount} -> ${finalAmount}`);

      // 利益計算
      const initialUSDC = Number(testPath.amount);
      const finalUSDC = Number(finalAmount);
      const profit = finalUSDC - initialUSDC;
      const profitPercent = (profit / initialUSDC) * 100;
      const profitUSD = profit / 1e6; // USDC has 6 decimals

      console.log(`   📊 Result: ${profitPercent.toFixed(6)}% ($${profitUSD.toFixed(6)})`);

      if (profitPercent > 0) {
        results.arbitrageOpportunities.push({
          path: testPath.name,
          profitPercent: profitPercent,
          profitUSD: profitUSD,
          initialAmount: initialUSDC / 1e6,
          finalAmount: finalUSDC / 1e6
        });
        console.log(`   🎯 OPPORTUNITY FOUND!`);
      } else {
        console.log(`   📉 No profit (${profitPercent.toFixed(6)}%)`);
      }

    } catch (error) {
      console.log(`   ❌ Error: ${error}`);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // 6️⃣ ガス価格制限チェック
  console.log("\n6️⃣ ガス価格制限診断...");
  const gasLimits = [20, 25, 30, 40, 50]; // Gwei
  console.log(`Current gas price: ${results.gasPrice.toFixed(2)} Gwei`);
  
  for (const limit of gasLimits) {
    const status = results.gasPrice <= limit ? '✅' : '❌';
    console.log(`   ${status} ${limit} Gwei limit: ${results.gasPrice <= limit ? 'PASS' : 'BLOCKED'}`);
  }

  // 7️⃣ 利益率設定チェック
  console.log("\n7️⃣ 利益率設定診断...");
  const profitThresholds = [0.01, 0.05, 0.1, 0.15, 0.2]; // %
  console.log("スキャンで発見された機会数:");
  
  for (const threshold of profitThresholds) {
    const opportunitiesAtThreshold = results.arbitrageOpportunities.filter(
      op => op.profitPercent >= threshold
    ).length;
    console.log(`   ${threshold}%以上: ${opportunitiesAtThreshold}件`);
  }

  // 📊 総合診断結果
  console.log("\n📊 === 診断結果サマリー ===");
  console.log(`RPC接続: ${results.rpcConnection ? '✅' : '❌'}`);
  console.log(`API接続: ${results.apiConnection ? '✅' : '❌'}`);
  console.log(`ガス価格: ${results.gasPrice.toFixed(2)} Gwei`);
  console.log(`発見機会: ${results.arbitrageOpportunities.length}件`);
  console.log(`設定問題: ${results.configIssues.length}件`);

  if (results.configIssues.length > 0) {
    console.log("\n❌ 設定問題:");
    results.configIssues.forEach(issue => console.log(`   - ${issue}`));
  }

  // 💡 改善提案
  console.log("\n💡 === 改善提案 ===");
  
  if (!results.rpcConnection) {
    console.log("🔧 RPC接続を確認してください");
  }
  
  if (!results.apiConnection) {
    console.log("🔧 0x API キーを確認してください");
  }
  
  if (results.gasPrice > 30) {
    console.log("🔧 ガス価格が高すぎます。MAX_PRICE_GWEIを上げるか、ガス価格が下がるまで待機");
  }
  
  if (results.arbitrageOpportunities.length === 0) {
    console.log("🔧 利益機会が見つかりません。以下を試してください:");
    console.log("   - 最小利益率を0.01%まで下げる");
    console.log("   - より多くのトークンペアを追加");
    console.log("   - より大きな借入額でテスト");
    console.log("   - 異なる時間帯に再実行");
  } else {
    console.log("🎯 機会は見つかっています！設定を調整してください:");
    console.log(`   - 最小利益率を ${Math.min(...results.arbitrageOpportunities.map(op => op.profitPercent)).toFixed(4)}% まで下げる`);
    console.log("   - ガス価格上限を現在のガス価格以上に設定");
  }

  return results;
}

// 🔧 設定修正用のヘルパー関数
async function generateOptimalConfig() {
  console.log("\n🔧 === 最適設定生成 ===");
  
  const diagnostics = await runComprehensiveDiagnostics();
  
  if (diagnostics.arbitrageOpportunities.length > 0) {
    const minProfitPercent = Math.min(...diagnostics.arbitrageOpportunities.map(op => op.profitPercent));
    const recommendedMinProfit = Math.max(0.01, minProfitPercent * 0.8); // 80%マージン
    
    console.log("\n🎯 推奨設定:");
    console.log(`MIN_PERCENTAGE: ${recommendedMinProfit.toFixed(4)} // 現在発見できる最小利益の80%`);
    console.log(`MAX_PRICE_GWEI: ${Math.max(35, diagnostics.gasPrice + 5)} // 現在ガス価格+5 Gwei`);
    console.log(`AGGRESSIVENESS_LEVEL: 3 // より多くのパスをチェック`);
    console.log(`BLOCK_INTERVAL: 3 // より頻繁にスキャン`);
    
    console.log("\n🔧 .envファイルに追加:");
    console.log(`MIN_PROFIT_PERCENTAGE=${recommendedMinProfit.toFixed(4)}`);
    console.log(`MAX_GAS_PRICE_GWEI=${Math.max(35, diagnostics.gasPrice + 5)}`);
    console.log(`AGGRESSIVENESS_LEVEL=3`);
  }
}

// ⚡ 緊急修正: 即座に試せる超積極的設定
function printEmergencyConfig() {
  console.log("\n⚡ === 緊急修正設定 ===");
  console.log("以下の設定をbalancer_scanner.tsで試してください:\n");
  
  console.log(`// 超積極的設定（テスト用）
const EMERGENCY_CONFIG = {
  PROFIT: {
    MIN_PERCENTAGE: 0.01,     // 0.01% (超低設定)
    MIN_AMOUNT_USD: 1,        // $1以上
    GAS_MULTIPLIER: 1.2,      // ガス代の1.2倍のみ
  },
  GAS: {
    MAX_PRICE_GWEI: 100,      // 100 Gwei (超高設定)
    PRIORITY_FEE_GWEI: 2,
  },
  MONITORING: {
    BLOCK_INTERVAL: 1,        // 毎ブロックスキャン
  }
};

// 使用方法：
// const ACTIVE_CONFIG = EMERGENCY_CONFIG; // 元の設定と置き換え`);
}

// メイン実行
async function main() {
  try {
    await runComprehensiveDiagnostics();
    await generateOptimalConfig();
    printEmergencyConfig();
  } catch (error) {
    console.error("診断エラー:", error);
  }
}

// 実行（診断ツールとして独立実行）
if (require.main === module) {
  main();
}

export { runComprehensiveDiagnostics, generateOptimalConfig };