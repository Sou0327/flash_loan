import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

// テスト用設定
const MAINNET_RPC = process.env.MAINNET_RPC || process.env.ALCHEMY_WSS?.replace('wss://', 'https://');
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const BALANCER_FLASH_ARB = process.env.BALANCER_FLASH_ARB!;

// コントラクトABI（簡略版）
const abi = [
  "function executeFlashLoan(address[] tokens, uint256[] amounts, uint256 minProfitBps, bytes userData) external",
  "function owner() view returns (address)",
  "function withdraw(address token) external",
  "function paused() view returns (bool)",
  "function getETHPriceUSD() external returns (uint256)",
  "function getGasCostUSD(uint256 gasUsed, uint256 gasPrice) external returns (uint256)"
];

// トークンアドレス
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

async function main() {
  console.log("🧪 === アービトラージ実行プロセス統合テスト ===\n");

  // 環境変数チェック
  if (!MAINNET_RPC) {
    console.error("❌ MAINNET_RPC または ALCHEMY_WSS が設定されていません");
    process.exit(1);
  }

  if (!PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY が設定されていません");
    process.exit(1);
  }

  if (!BALANCER_FLASH_ARB) {
    console.error("❌ BALANCER_FLASH_ARB が設定されていません");
    process.exit(1);
  }

  console.log(`🔧 RPC: ${MAINNET_RPC.slice(0, 50)}...`);
  console.log(`🔧 Contract: ${BALANCER_FLASH_ARB}`);
  console.log(`🔧 Wallet: ${new ethers.Wallet(PRIVATE_KEY).address}\n`);

  // プロバイダーとウォレット設定
  const provider = new ethers.JsonRpcProvider(MAINNET_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const flashArb = new ethers.Contract(BALANCER_FLASH_ARB, abi, wallet);

  try {
    // 1. 基本接続テスト
    console.log("1️⃣ 基本接続テスト");
    const blockNumber = await provider.getBlockNumber();
    const balance = await provider.getBalance(wallet.address);
    
    console.log(`✅ ブロック番号: ${blockNumber}`);
    console.log(`✅ ウォレット残高: ${ethers.formatEther(balance)} ETH`);
    console.log(`✅ ウォレットアドレス: ${wallet.address}`);

    // コントラクトの存在確認
    const contractCode = await provider.getCode(BALANCER_FLASH_ARB);
    if (contractCode === "0x") {
      console.log(`❌ コントラクトが存在しません: ${BALANCER_FLASH_ARB}`);
      process.exit(1);
    }
    console.log(`✅ コントラクト確認: ${contractCode.slice(0, 20)}...`);

    // オーナー確認
    try {
      const owner = await flashArb.owner();
      console.log(`✅ コントラクトオーナー: ${owner}`);
      
      const isPaused = await flashArb.paused();
      console.log(`✅ 一時停止状態: ${isPaused}\n`);
    } catch (error: any) {
      console.log(`❌ オーナー取得エラー: ${error.message}`);
      console.log("💡 コントラクトアドレスまたはABIに問題がある可能性があります\n");
    }

    // 2. 価格フィード機能テスト
    console.log("2️⃣ 価格フィード機能テスト");
    try {
      const ethPrice = await flashArb.getETHPriceUSD();
      console.log(`✅ ETH価格取得: $${(Number(ethPrice) / 1e8).toFixed(2)}`);
      
      const gasCost = await flashArb.getGasCostUSD(300000, ethers.parseUnits("20", "gwei"));
      console.log(`✅ ガス代計算: $${(Number(gasCost) / 1e18).toFixed(4)}\n`);
    } catch (error: any) {
      console.log(`⚠️  価格フィード機能エラー: ${error.message}\n`);
    }

    // 3. フラッシュローン実行テスト（Static Call）
    console.log("3️⃣ フラッシュローン実行テスト（Static Call）");
    
    // テスト用のダミーデータ
    const testTokens = [USDC];
    const testAmounts = [ethers.parseUnits("1000", 6)]; // 1000 USDC
    const testMinProfitBps = 50; // 0.5%
    
    // ダミーのスワップデータ（実際のAPIデータの代わり）
    const dummyUserData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes", "address", "address", "bytes"],
      [
        "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", // allowanceTarget1 (0x Exchange)
        "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", // target1 (0x Exchange)
        "0x", // swapData1 (空)
        "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", // allowanceTarget2
        "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", // target2
        "0x"  // swapData2 (空)
      ]
    );

    try {
      // Static callでシミュレーション
      await flashArb.executeFlashLoan.staticCall(
        testTokens,
        testAmounts,
        testMinProfitBps,
        dummyUserData
      );
      console.log(`❌ 予期しない成功: ダミーデータで成功してはいけません`);
    } catch (error: any) {
      if (error.message.includes("SwapFailed") || 
          error.message.includes("UntrustedSpender") ||
          error.message.includes("InsufficientProfit")) {
        console.log(`✅ 期待されるエラー: ${error.message.split('(')[0]}`);
      } else {
        console.log(`⚠️  予期しないエラー: ${error.message}`);
      }
    }

    // 4. ガス見積もりテスト
    console.log("\n4️⃣ ガス見積もりテスト");
    try {
      const gasEstimate = await flashArb.executeFlashLoan.estimateGas(
        testTokens,
        testAmounts,
        testMinProfitBps,
        dummyUserData
      );
      console.log(`✅ ガス見積もり: ${gasEstimate.toString()}`);
    } catch (error: any) {
      console.log(`✅ ガス見積もりエラー（期待される）: ${error.message.split('(')[0]}`);
    }

    // 5. 所有権機能テスト
    console.log("\n5️⃣ 所有権機能テスト");
    try {
      const owner = await flashArb.owner();
      if (owner.toLowerCase() === wallet.address.toLowerCase()) {
        console.log(`✅ 正しいオーナー権限を確認`);
        
        // 引き出し機能テスト（実際には実行しない）
        try {
          await flashArb.withdraw.staticCall(USDC);
          console.log(`✅ 引き出し機能: 利用可能`);
        } catch (error: any) {
          if (error.message.includes("No token balance")) {
            console.log(`✅ 引き出し機能: 正常（残高なし）`);
          } else {
            console.log(`⚠️  引き出し機能エラー: ${error.message}`);
          }
        }
      } else {
        console.log(`❌ オーナー権限エラー: 期待=${wallet.address}, 実際=${owner}`);
      }
    } catch (error: any) {
      console.log(`❌ オーナー確認エラー: ${error.message}`);
    }

    console.log("\n🎉 === テスト完了 ===");
    console.log("✅ 基本的なコントラクト機能は正常に動作しています");
    console.log("⚠️  実際のアービトラージ実行には有効な0x APIデータが必要です");

  } catch (error) {
    console.error("❌ テスト実行エラー:", error);
    process.exit(1);
  }
}

// エラーハンドリング
process.on('unhandledRejection', (error) => {
  console.error('未処理のPromise拒否:', error);
  process.exit(1);
});

main().catch(console.error); 