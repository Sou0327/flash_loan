import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  console.log("🚀 Deploying BalancerFlashLoanArb to Mainnet...");
  
  // Balancer Vault address on Mainnet
  const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
  
  // ガス設定
  const feeData = await ethers.provider.getFeeData();
  console.log(`⛽ Current gas price: ${ethers.formatUnits(feeData.gasPrice || 0n, "gwei")} Gwei`);
  
  // デプロイ実行
  const BalancerFlashLoanArb = await ethers.getContractFactory("BalancerFlashLoanArb");
  const flashArb = await BalancerFlashLoanArb.deploy(BALANCER_VAULT, {
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    gasLimit: 2000000n
  });

  await flashArb.waitForDeployment();
  const contractAddress = await flashArb.getAddress();

  console.log("✅ BalancerFlashLoanArb deployed successfully!");
  console.log(`📍 Contract address: ${contractAddress}`);
  console.log(`🔗 Etherscan: https://etherscan.io/address/${contractAddress}`);
  
  // オーナー確認
  const owner = await flashArb.owner();
  console.log(`👤 Owner: ${owner}`);
  
  // 残高確認
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`💰 Deployer balance: ${ethers.formatEther(balance)} ETH`);
  
  console.log("\n🎯 Next steps:");
  console.log("1. Update BALANCER_FLASH_ARB in .env file");
  console.log("2. Run the scanner with the new contract address");
  console.log("3. Monitor for arbitrage opportunities");
}

main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exitCode = 1;
}); 