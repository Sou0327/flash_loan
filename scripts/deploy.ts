import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\n🚀 Deploying from: ${deployer.address}`);
  console.log(`🔗 Network: ${network.name}`);

  // Aave V3 PoolAddressesProvider (Ethereum Mainnet)
  const AAVE_PROVIDER = "0xa97684ead0e402dc232d5a977953df7ecbab3cdb"; // 変える場合は .env で上書き可能

  const FlashLoanArb = await ethers.getContractFactory("FlashLoanArb");
  const contract = await FlashLoanArb.deploy(AAVE_PROVIDER);
  await contract.deployed();

  console.log(`✅ Deployed FlashLoanArb at: ${contract.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});