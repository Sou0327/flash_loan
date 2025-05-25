import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  console.log("🚀 Deploying BalancerFlashLoanArb to MAINNET");
  console.log("============================================");
  
  const [deployer] = await ethers.getSigners();
  console.log(`👤 Deployer: ${deployer.address}`);
  
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`💰 Balance: ${ethers.formatEther(balance)} ETH`);
  
  // 最小残高チェック
  const minBalance = ethers.parseEther("0.01"); // 0.01 ETH
  if (balance < minBalance) {
    console.error("❌ Insufficient ETH balance for deployment");
    console.error(`💡 Need at least 0.01 ETH, have ${ethers.formatEther(balance)} ETH`);
    return;
  }
  
  // Balancer Vault address on mainnet
  const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
  
  console.log("⚠️  MAINNET DEPLOYMENT WARNING");
  console.log("This will deploy to Ethereum Mainnet using real ETH!");
  console.log("Press Ctrl+C to cancel, or wait 5 seconds to continue...");
  
  // 5秒待機
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  const BalancerFlashLoanArb = await ethers.getContractFactory("BalancerFlashLoanArb");
  
  console.log("📦 Deploying contract to MAINNET...");
  
  // ガス価格を取得
  const feeData = await ethers.provider.getFeeData();
  console.log(`⛽ Gas Price: ${ethers.formatUnits(feeData.gasPrice || 0n, "gwei")} gwei`);
  
  const flashArb = await BalancerFlashLoanArb.deploy(BALANCER_VAULT, {
    gasLimit: 3000000,
    gasPrice: feeData.gasPrice
  });
  
  console.log("⏳ Waiting for deployment confirmation...");
  await flashArb.waitForDeployment();
  
  const contractAddress = await flashArb.getAddress();
  console.log(`✅ Contract deployed to MAINNET: ${contractAddress}`);
  
  // デプロイ情報を表示
  console.log(`\n📋 Deployment Summary:`);
  console.log(`📍 Contract Address: ${contractAddress}`);
  console.log(`👤 Owner: ${deployer.address}`);
  console.log(`🏦 Balancer Vault: ${BALANCER_VAULT}`);
  
  // .envファイル用の出力
  console.log(`\n📝 Update .env file:`);
  console.log(`BALANCER_FLASH_ARB=${contractAddress}`);
  
  // 次のステップ
  console.log(`\n🔄 Next Steps:`);
  console.log(`1. Update .env with new contract address`);
  console.log(`2. Run arbitrage scanner with small amounts`);
  console.log(`3. Monitor gas costs and profits carefully`);
  console.log(`4. Start with 100-1000 USDC test amounts`);
  
  console.log(`\n⚠️  Important Reminders:`);
  console.log(`• This contract is now live on mainnet`);
  console.log(`• Only you (${deployer.address}) can execute arbitrage`);
  console.log(`• Always test with small amounts first`);
  console.log(`• Monitor gas costs vs profits`);
  
  return contractAddress;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}); 