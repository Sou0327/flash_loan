import { ethers } from 'hardhat';

async function testSimpleFlashLoan() {
  console.log("🧪 === 簡単なフラッシュローンテスト ===");
  
  // コントラクトアドレス
  const BALANCER_FLASH_ARB = process.env.CONTRACT_ADDRESS || "0x031b661cCfa936c2ec33ff90A31A354d90b8e38c";
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  
  try {
    // ウォレット設定
    const [deployer] = await ethers.getSigners();
    console.log(`📝 Using wallet: ${deployer.address}`);
    
    // コントラクト接続
    const flashArb = await ethers.getContractAt("BalancerFlashLoanArb", BALANCER_FLASH_ARB);
    console.log(`📄 Contract connected: ${BALANCER_FLASH_ARB}`);
    
    // 🔧 超シンプルなuserDataテスト
    console.log("\n🔧 Testing with minimal userData...");
    
    // 最小限のダミーデータ
    const dummyAddress = "0x000000000022d473030f116ddee9f6b43ac78ba3"; // Permit2
    const dummyCalldata = "0x"; // 空のcalldata
    
    const simpleUserData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes", "address", "address", "bytes"],
      [
        dummyAddress,  // allowanceTarget1
        dummyAddress,  // target1
        dummyCalldata, // swapData1
        dummyAddress,  // allowanceTarget2  
        dummyAddress,  // target2
        dummyCalldata  // swapData2
      ]
    );
    
    console.log(`📏 Simple userData length: ${simpleUserData.length} bytes`);
    
    // テスト金額（小額）
    const testAmount = ethers.parseUnits("100", 6); // 100 USDC
    
    console.log(`💰 Test amount: ${ethers.formatUnits(testAmount, 6)} USDC`);
    console.log(`🎯 Min profit: 50 bps (0.5%)`);
    
    // 🧪 Static call テスト
    console.log("\n🧪 Running static simulation...");
    
    try {
      await flashArb.executeFlashLoan.staticCall(
        [USDC],
        [testAmount], 
        50, // 0.5%
        simpleUserData,
        {
          gasLimit: BigInt(500000)
        }
      );
      
      console.log("✅ Static simulation passed!");
      
      // 実際の実行はしない（テスト目的）
      console.log("⚠️ Skipping real execution in test mode");
      
    } catch (simError) {
      console.log("❌ Static simulation failed:");
      console.log(`   Error: ${simError instanceof Error ? simError.message : String(simError)}`);
      
      // より詳細なエラー分析
      if (simError instanceof Error) {
        if (simError.message.includes('UntrustedSpender')) {
          console.log("🔍 Issue: Untrusted spender detected");
          console.log("🔧 Solution: Add spender to trusted list");
        } else if (simError.message.includes('InsufficientProfit')) {
          console.log("🔍 Issue: Insufficient profit");
          console.log("🔧 Solution: Increase amount or reduce minProfitBps");
        } else if (simError.message.includes('SwapFailed')) {
          console.log("🔍 Issue: Swap execution failed");
          console.log("🔧 Solution: Fix calldata or target addresses");
        }
      }
    }
    
    console.log("\n📊 Test completed");
    
  } catch (error) {
    console.error("❌ Test failed:", error instanceof Error ? error.message : String(error));
  }
}

// メイン実行
if (require.main === module) {
  testSimpleFlashLoan()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { testSimpleFlashLoan }; 