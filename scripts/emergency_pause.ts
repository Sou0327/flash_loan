import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const BALANCER_FLASH_ARB = process.env.BALANCER_FLASH_ARB;
  
  if (!BALANCER_FLASH_ARB) {
    throw new Error("BALANCER_FLASH_ARB address not found in environment variables");
  }

  console.log("🚨 Emergency Pause Initiated...");
  
  const [deployer] = await ethers.getSigners();
  console.log("👤 Pausing with account:", deployer.address);

  const BalancerFlashLoanArb = await ethers.getContractFactory("BalancerFlashLoanArb");
  const flashArb = BalancerFlashLoanArb.attach(BALANCER_FLASH_ARB);

  // 現在の状態確認
  const isPaused = await flashArb.paused();
  console.log("📊 Current status:", isPaused ? "PAUSED" : "ACTIVE");

  if (isPaused) {
    console.log("⚠️  Contract is already paused");
    return;
  }

  // 緊急停止実行
  console.log("⏸️  Executing pause...");
  const tx = await flashArb.pause();
  console.log("📜 Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("✅ Pause executed successfully!");
  console.log("⛽ Gas used:", receipt?.gasUsed.toString());

  // 停止確認
  const newStatus = await flashArb.paused();
  console.log("📊 New status:", newStatus ? "PAUSED ✅" : "ACTIVE ❌");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Emergency pause failed:", error);
    process.exit(1);
  }); 