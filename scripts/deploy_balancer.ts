import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\n🚀 Deploying Balancer Flash Loan Arb from: ${deployer.address}`);
  console.log(`🔗 Network: ${network.name}`);

  // Balancer V2 Vault (Ethereum Mainnet)
  const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

  const BalancerFlashLoanArb = await ethers.getContractFactory("BalancerFlashLoanArb");
  const contract = await BalancerFlashLoanArb.deploy(BALANCER_VAULT);
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  console.log(`✅ Deployed BalancerFlashLoanArb at: ${contractAddress}`);
  
  // Verify deployment
  const owner = await contract.owner();
  console.log(`👤 Contract owner: ${owner}`);
  
  console.log(`\n💡 Add this to your .env file:`);
  console.log(`BALANCER_FLASH_ARB=${contractAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});