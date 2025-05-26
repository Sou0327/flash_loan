import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  console.log("🚀 Deploying updated BalancerFlashLoanArb contract...");
  
  // Balancer Vault address (Mainnet)
  const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
  
  // Deploy contract
  const BalancerFlashLoanArb = await ethers.getContractFactory("BalancerFlashLoanArb");
  const contract = await BalancerFlashLoanArb.deploy(BALANCER_VAULT);
  
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  
  console.log("✅ Contract deployed!");
  console.log(`📍 Address: ${contractAddress}`);
  console.log(`👤 Owner: ${await contract.owner()}`);
  
  // Update .env file
  console.log("\n📝 Update your .env file:");
  console.log(`BALANCER_FLASH_ARB=${contractAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}); 