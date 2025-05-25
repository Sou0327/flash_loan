import { ethers } from "hardhat";

async function main() {
  console.log("🧪 Deploying BalancerFlashLoanArb to Fork Environment...");
  
  // Balancer Vault address on mainnet
  const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
  
  const [deployer] = await ethers.getSigners();
  console.log("👤 Deploying with account:", deployer.address);
  
  // 残高確認
  const balance = await deployer.provider.getBalance(deployer.address);
  console.log("💰 Account balance:", ethers.formatEther(balance), "ETH");
  
  // コントラクトをデプロイ
  const BalancerFlashLoanArb = await ethers.getContractFactory("BalancerFlashLoanArb");
  
  // フォーク環境用のガス設定
  const flashArb = await BalancerFlashLoanArb.deploy(BALANCER_VAULT, {
    gasLimit: 3000000,
    gasPrice: ethers.parseUnits("20", "gwei") // 固定ガス価格
  });
  
  await flashArb.waitForDeployment();
  const contractAddress = await flashArb.getAddress();
  
  console.log("✅ BalancerFlashLoanArb deployed successfully!");
  console.log("📍 Contract address:", contractAddress);
  console.log("👤 Owner:", await flashArb.owner());
  
  // デプロイ後の残高
  const balanceAfter = await deployer.provider.getBalance(deployer.address);
  console.log("💰 Deployer balance after:", ethers.formatEther(balanceAfter), "ETH");
  
  console.log("\n🎯 Next steps for fork testing:");
  console.log("1. Update BALANCER_FLASH_ARB in .env file");
  console.log("2. Run the scanner with fork RPC URL");
  console.log("3. Test arbitrage opportunities");
  
  return contractAddress;
}

main()
  .then((address) => {
    console.log(`\n📋 Contract deployed at: ${address}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }); 