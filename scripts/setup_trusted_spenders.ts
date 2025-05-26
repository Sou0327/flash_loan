import { ethers } from 'hardhat';

async function setupTrustedSpenders() {
  console.log("🔧 Setting up trusted spenders...");

  try {
    const [deployer] = await ethers.getSigners();
    const CONTRACT_ADDRESS = "0x031b661cCfa936c2ec33ff90A31A354d90b8e38c";
    
    const flashArb = await ethers.getContractAt("BalancerFlashLoanArb", CONTRACT_ADDRESS);

    // 🔧 ログから特定されたスワップターゲットを追加
    const commonTargets = [
      "0x000000000022d473030f116ddee9f6b43ac78ba3", // Permit2 (頻出ターゲット)
      "0x5418226af9c8d5d287a78fbbbcd337b86ec07d61", // 頻出ターゲット
      "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", // 0x Exchange Proxy
      "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // Uniswap V3 Router
      "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2 Router
      "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap V3 SwapRouter
      "0x1111111254EEB25477B68fb85Ed929f73A960582", // 1inch Aggregation Router
      "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F", // SushiSwap Router
    ];

    console.log(`Setting up ${commonTargets.length} trusted spenders...`);

    for (const target of commonTargets) {
      try {
        console.log(`📝 Adding trusted spender: ${target}`);
        
        // 現在の状態をチェック
        const isCurrentlyTrusted = await flashArb.trustedSpenders(target);
        
        if (isCurrentlyTrusted) {
          console.log(`✅ Already trusted: ${target}`);
          continue;
        }

        // 信頼できるスペンダーに追加
        const tx = await flashArb.setTrustedSpender(target, true, {
          gasLimit: 100000,
          gasPrice: ethers.parseUnits("20", "gwei") // 20 Gwei
        });
        
        console.log(`⏳ Transaction sent: ${tx.hash}`);
        const receipt = await tx.wait();
        
        if (receipt?.status === 1) {
          console.log(`✅ Successfully added: ${target}`);
        } else {
          console.log(`❌ Failed to add: ${target}`);
        }
        
        // API制限対策
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.error(`❌ Error adding ${target}:`, error instanceof Error ? error.message : String(error));
      }
    }

    console.log("🔧 Trusted spenders setup completed");

    // 🔍 現在の信頼されたスペンダーを確認
    console.log("\n🔍 Checking current trusted spenders:");
    for (const target of commonTargets) {
      const isTrusted = await flashArb.trustedSpenders(target);
      console.log(`${target}: ${isTrusted ? '✅ Trusted' : '❌ Not trusted'}`);
    }

  } catch (error) {
    console.error("❌ Setup failed:", error instanceof Error ? error.message : String(error));
  }
}

// メイン実行
if (require.main === module) {
  setupTrustedSpenders()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { setupTrustedSpenders }; 