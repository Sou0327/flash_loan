import { ethers } from 'hardhat';

async function checkOwnership() {
  console.log("👑 === Contract Ownership Check ===");
  
  const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x031b661cCfa936c2ec33ff90A31A354d90b8e38c";
  
  try {
    const [deployer] = await ethers.getSigners();
    console.log(`📝 Current wallet: ${deployer.address}`);
    
    const flashArb = await ethers.getContractAt("BalancerFlashLoanArb", CONTRACT_ADDRESS);
    console.log(`📄 Contract: ${CONTRACT_ADDRESS}`);
    
    // 所有者確認
    const currentOwner = await flashArb.owner();
    console.log(`👑 Current owner: ${currentOwner}`);
    
    const isOwner = currentOwner.toLowerCase() === deployer.address.toLowerCase();
    console.log(`🔍 Is current wallet the owner? ${isOwner ? '✅ YES' : '❌ NO'}`);
    
    if (!isOwner) {
      console.log("\n❌ You are not the owner of this contract!");
      console.log("🔧 Possible solutions:");
      console.log("   1. Use the correct owner wallet");
      console.log("   2. Transfer ownership to current wallet");
      console.log("   3. Use a different contract you own");
      
      // ETH残高チェック
      const balance = await ethers.provider.getBalance(deployer.address);
      console.log(`💰 Current wallet balance: ${ethers.formatEther(balance)} ETH`);
      
      if (parseFloat(ethers.formatEther(balance)) < 0.01) {
        console.log("⚠️ Low ETH balance - ensure you have enough for gas fees");
      }
    } else {
      console.log("\n✅ You are the owner! You can manage trusted spenders.");
      
      // 現在の信頼されているスペンダーの確認
      const commonTargets = [
        "0x000000000022d473030f116ddee9f6b43ac78ba3", // Permit2
        "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", // 0x Exchange Proxy
        "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // Uniswap V3 Router
        "0x5418226af9c8d5d287a78fbbbcd337b86ec07d61"  // 問題のターゲット
      ];
      
      console.log("\n🔍 Checking current trusted spenders...");
      for (const target of commonTargets) {
        try {
          const isTrusted = await flashArb.trustedSpenders(target);
          console.log(`${isTrusted ? '✅' : '❌'} ${target}`);
        } catch (error) {
          console.log(`❓ ${target} - Error checking`);
        }
      }
    }
    
  } catch (error) {
    console.error("❌ Check failed:", error instanceof Error ? error.message : String(error));
  }
}

// メイン実行
if (require.main === module) {
  checkOwnership()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { checkOwnership }; 