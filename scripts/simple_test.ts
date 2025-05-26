import { ethers } from 'hardhat';

async function simpleTest() {
  console.log("🧪 === Simple Contract Test ===");
  
  const CONTRACT_ADDRESS = "0x031b661cCfa936c2ec33ff90A31A354d90b8e38c";
  
  try {
    const [deployer] = await ethers.getSigners();
    console.log(`👤 Wallet: ${deployer.address}`);
    
    const flashArb = await ethers.getContractAt("BalancerFlashLoanArb", CONTRACT_ADDRESS);
    
    // 基本状態確認
    console.log("📊 Basic Status:");
    const owner = await flashArb.owner();
    const paused = await flashArb.paused();
    
    console.log(`   Owner: ${owner}`);
    console.log(`   Paused: ${paused}`);
    console.log(`   Is Owner: ${owner.toLowerCase() === deployer.address.toLowerCase()}`);
    
    // 特定のspenderをテスト
    const testSpender = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF"; // 0x Exchange Proxy
    
    console.log(`\n🔍 Testing spender: ${testSpender}`);
    
    try {
      const isTrusted = await flashArb.trustedSpenders(testSpender);
      console.log(`   Currently trusted: ${isTrusted}`);
      
      if (!isTrusted) {
        console.log("   Attempting to add...");
        
        // Dry run (staticCall)
        try {
          await flashArb.setTrustedSpender.staticCall(testSpender, true);
          console.log("   ✅ Static call succeeded");
          
          // Actual call
          const tx = await flashArb.setTrustedSpender(testSpender, true, {
            gasLimit: 200000,
            gasPrice: ethers.parseUnits("25", "gwei")
          });
          
          console.log(`   ⏳ TX: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`   📊 Status: ${receipt?.status === 1 ? 'Success' : 'Failed'}`);
          
        } catch (staticError) {
          console.log(`   ❌ Static call failed: ${staticError instanceof Error ? staticError.message : String(staticError)}`);
        }
      }
      
    } catch (readError) {
      console.log(`   ❌ Read failed: ${readError instanceof Error ? readError.message : String(readError)}`);
    }
    
  } catch (error) {
    console.error("❌ Test failed:", error instanceof Error ? error.message : String(error));
  }
}

// メイン実行
if (require.main === module) {
  simpleTest()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { simpleTest }; 