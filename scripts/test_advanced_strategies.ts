import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { runAdvancedArbitrageDetection } from '../src/advanced-arbitrage-detector';

dotenv.config();

async function testAdvancedStrategies() {
  console.log("🚀 高度なアービトラージ戦略テスト開始\n");

  // プロバイダー設定
  const provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC);
  const apiKey = process.env.ZX_API_KEY;

  if (!apiKey) {
    console.error("❌ ZX_API_KEY が設定されていません");
    process.exit(1);
  }

  try {
    // 現在のブロック番号とガス価格を表示
    const blockNumber = await provider.getBlockNumber();
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    const gasPriceGwei = gasPrice ? parseFloat(ethers.formatUnits(gasPrice, 'gwei')) : 0;

    console.log(`📊 現在の状況:`);
    console.log(`   ブロック番号: ${blockNumber}`);
    console.log(`   ガス価格: ${gasPriceGwei.toFixed(2)} Gwei`);
    console.log(`   API キー: ${apiKey.substring(0, 8)}...`);
    console.log("");

    // 高度な戦略を実行
    const results = await runAdvancedArbitrageDetection(provider, apiKey);

    // 結果の詳細表示
    console.log("\n📊 === 詳細結果 ===");
    
    if (results.largeAmount.length > 0) {
      console.log("\n💰 大型金額アービトラージ機会:");
      results.largeAmount.forEach((opp: any, index: number) => {
        console.log(`   ${index + 1}. ${opp.path} - ${opp.profitPercent.toFixed(4)}% (${opp.label})`);
      });
    }

    if (results.triangular.length > 0) {
      console.log("\n🔺 三角アービトラージ機会:");
      results.triangular.forEach((opp: any, index: number) => {
        console.log(`   ${index + 1}. ${opp.path} - ${opp.profitPercent.toFixed(4)}%`);
      });
    }

    if (results.alternative.length > 0) {
      console.log("\n🔄 代替トークン機会:");
      results.alternative.forEach((opp: any, index: number) => {
        console.log(`   ${index + 1}. ${opp.path} - ${opp.profitPercent.toFixed(4)}%`);
      });
    }

    if (results.priceImpact.length > 0) {
      console.log("\n📊 価格インパクト機会:");
      results.priceImpact.forEach((opp: any, index: number) => {
        console.log(`   ${index + 1}. ${opp.pair} - ${opp.profitPercent.toFixed(4)}% (Impact: ${opp.priceImpact?.toFixed(4)}%)`);
      });
    }

    // 推奨事項
    console.log("\n💡 === 推奨事項 ===");
    
    if (results.totalOpportunities === 0) {
      console.log("❌ 現在利益機会が見つかりません。以下を確認してください:");
      console.log("   1. 市場が非常に効率的な状態");
      console.log("   2. ガス価格が高すぎる可能性");
      console.log("   3. より大きな金額でのテストが必要");
      console.log("   4. 異なる時間帯での実行を検討");
    } else {
      console.log(`✅ ${results.totalOpportunities} 件の機会を発見！`);
      
      if (results.bestOpportunity) {
        console.log(`🏆 最良機会: ${results.bestOpportunity.path || results.bestOpportunity.pair}`);
        console.log(`💰 利益率: ${results.bestOpportunity.profitPercent.toFixed(4)}%`);
        console.log(`🎯 信頼度: ${(results.bestOpportunity.confidence * 100).toFixed(1)}%`);
        
        if (results.bestOpportunity.profitPercent > 0.1) {
          console.log("🚀 実行を検討する価値があります！");
        } else {
          console.log("⚠️ 利益率が低いため、ガス代を考慮すると実行は慎重に");
        }
      }
    }

    // 市場効率性の分析
    console.log("\n📈 === 市場分析 ===");
    const avgLoss = calculateAverageLoss();
    console.log(`平均往復損失: ${avgLoss.toFixed(4)}%`);
    
    if (avgLoss > 0.5) {
      console.log("🔴 市場は非常に効率的 - 従来手法では困難");
      console.log("💡 推奨: 高度戦略（三角アービトラージ、大型金額）に注力");
    } else if (avgLoss > 0.2) {
      console.log("🟡 市場は効率的 - 慎重な戦略が必要");
      console.log("💡 推奨: リスク管理を強化して実行");
    } else {
      console.log("🟢 市場に機会あり - 積極的実行可能");
    }

  } catch (error) {
    console.error("❌ テスト実行エラー:", error instanceof Error ? error.message : String(error));
  }
}

function calculateAverageLoss(): number {
  // 簡易的な市場効率性指標
  // 実際の実装では過去の取引データを使用
  return 0.3; // 仮の値
}

// メイン実行
if (require.main === module) {
  testAdvancedStrategies()
    .then(() => {
      console.log("\n✅ テスト完了");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ テスト失敗:", error);
      process.exit(1);
    });
} 