import { ethers } from 'hardhat';

async function analyzeFailedTransaction() {
  console.log("🔍 === Failed Transaction Analysis ===");
  
  const failedTxHash = "0x846ba9d11c635850613fc58a424eb40bb31164b0677f6c999ee2fcdf91ce8050";
  const CONTRACT_ADDRESS = "0x031b661cCfa936c2ec33ff90A31A354d90b8e38c";
  
  try {
    // プロバイダー設定
    const provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC);
    
    // トランザクション詳細取得
    const tx = await provider.getTransaction(failedTxHash);
    const receipt = await provider.getTransactionReceipt(failedTxHash);
    
    console.log(`📄 Transaction Hash: ${failedTxHash}`);
    console.log(`🎯 To: ${tx?.to}`);
    console.log(`💰 Value: ${ethers.formatEther(tx?.value || 0)} ETH`);
    console.log(`⛽ Gas Limit: ${tx?.gasLimit?.toString()}`);
    console.log(`⛽ Gas Used: ${receipt?.gasUsed?.toString()}`);
    console.log(`💸 Gas Price: ${ethers.formatUnits(tx?.gasPrice || 0, 'gwei')} Gwei`);
    console.log(`📊 Status: ${receipt?.status === 1 ? 'Success' : 'Failed'}`);
    
    // 失敗の場合の詳細分析
    if (receipt?.status === 0) {
      console.log("\n❌ Transaction Failed - Detailed Analysis:");
      
      // ガス関連の問題チェック
      const gasUsed = Number(receipt.gasUsed);
      const gasLimit = Number(tx?.gasLimit || 0);
      const gasUsagePercent = (gasUsed / gasLimit) * 100;
      
      console.log(`⛽ Gas Usage: ${gasUsed.toLocaleString()} / ${gasLimit.toLocaleString()} (${gasUsagePercent.toFixed(1)}%)`);
      
      if (gasUsagePercent > 95) {
        console.log("🔍 Likely cause: Out of gas");
      } else if (gasUsed < 21000) {
        console.log("🔍 Likely cause: Transaction reverted immediately");
      } else {
        console.log("🔍 Likely cause: Business logic revert");
      }
      
      // コントラクト状態チェック
      console.log("\n🔍 Contract State Analysis:");
      
      const [deployer] = await ethers.getSigners();
      const flashArb = await ethers.getContractAt("BalancerFlashLoanArb", CONTRACT_ADDRESS);
      
      // 基本状態確認
      const isPaused = await flashArb.paused();
      const owner = await flashArb.owner();
      
      console.log(`⏸️  Contract Paused: ${isPaused}`);
      console.log(`👑 Owner: ${owner}`);
      console.log(`📝 Sender: ${tx?.from}`);
      console.log(`🔑 Is Owner: ${owner.toLowerCase() === tx?.from?.toLowerCase()}`);
      
      // 一般的な失敗原因
      console.log("\n🔍 Common Failure Reasons:");
      console.log("1. UntrustedSpender - スワップターゲットが信頼されていない");
      console.log("2. InsufficientProfit - 利益が不十分");
      console.log("3. SwapFailed - スワップ実行失敗");
      console.log("4. InvalidFeeAmount - 手数料計算エラー");
      console.log("5. Price slippage - 価格スリッページ");
      
      // 具体的なrevert理由を取得しようと試行
      try {
        console.log("\n🧪 Attempting to reproduce failure...");
        
        // 同じパラメータでstatic callを実行
        const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
        const amount = ethers.parseUnits("3000", 6); // 3000 USDC
        
        // ダミーのuserData（実際のデータは不明）
        const dummyUserData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "bytes", "address", "address", "bytes"],
          [
            "0x000000000022d473030f116ddee9f6b43ac78ba3",
            "0x5418226af9c8d5d287a78fbbbcd337b86ec07d61", 
            "0x",
            "0x000000000022d473030f116ddee9f6b43ac78ba3",
            "0x5418226af9c8d5d287a78fbbbcd337b86ec07d61",
            "0x"
          ]
        );
        
        await flashArb.executeFlashLoan.staticCall(
          [usdc],
          [amount],
          231, // minProfitBps from logs
          dummyUserData
        );
        
        console.log("✅ Static call succeeded - issue may be timing/market related");
        
      } catch (staticError) {
        console.log("❌ Static call also failed:");
        console.log(`   Error: ${staticError instanceof Error ? staticError.message : String(staticError)}`);
        
        // エラーの詳細分析
        if (staticError instanceof Error) {
          if (staticError.message.includes('UntrustedSpender')) {
            console.log("🎯 Root Cause: Untrusted spender detected");
            console.log("🔧 Solution: Add swap targets to trusted spenders list");
          } else if (staticError.message.includes('InsufficientProfit')) {
            console.log("🎯 Root Cause: Insufficient profit after fees");
            console.log("🔧 Solution: Market moved unfavorably between detection and execution");
          } else if (staticError.message.includes('SwapFailed')) {
            console.log("🎯 Root Cause: Swap execution failed");
            console.log("🔧 Solution: Invalid calldata or target addresses");
          }
        }
      }
    }
    
  } catch (error) {
    console.error("❌ Analysis failed:", error instanceof Error ? error.message : String(error));
  }
}

// メイン実行
if (require.main === module) {
  analyzeFailedTransaction()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { analyzeFailedTransaction }; 