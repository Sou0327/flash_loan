import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

async function manualWithdraw() {
  console.log("💸 Manual Withdrawal Script");
  
  // 設定
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const RPC_URL = process.env.MAINNET_RPC;
  const BALANCER_FLASH_ARB = process.env.BALANCER_FLASH_ARB;
  const USDC = process.env.USDC || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  
  if (!PRIVATE_KEY || !RPC_URL || !BALANCER_FLASH_ARB) {
    console.error("❌ Missing required environment variables");
    process.exit(1);
  }
  
  // プロバイダーとウォレット
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  
  // コントラクト
  const abi = [
    "function withdraw(address token) external",
    "function owner() view returns (address)"
  ];
  const flashArb = new ethers.Contract(BALANCER_FLASH_ARB, abi, wallet);
  
  try {
    // オーナー確認
    const owner = await flashArb.owner();
    console.log(`📋 Contract owner: ${owner}`);
    console.log(`👤 Your address: ${wallet.address}`);
    
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error("❌ You are not the contract owner");
      process.exit(1);
    }
    
    // 引き出し前の残高確認
    const tokenContract = new ethers.Contract(
      USDC,
      ["function balanceOf(address) view returns (uint256)"],
      provider
    );
    
    const contractBalance = await tokenContract.balanceOf(BALANCER_FLASH_ARB);
    const walletBalanceBefore = await tokenContract.balanceOf(wallet.address);
    
    console.log(`💰 Contract USDC balance: ${ethers.formatUnits(contractBalance, 6)}`);
    console.log(`💰 Your USDC balance before: ${ethers.formatUnits(walletBalanceBefore, 6)}`);
    
    if (contractBalance === 0n) {
      console.log("⚠️  No USDC to withdraw from contract");
      return;
    }
    
    // 引き出し実行
    console.log("🚀 Executing withdrawal...");
    const tx = await flashArb.withdraw(USDC);
    console.log(`📜 Transaction: ${tx.hash}`);
    
    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      // 引き出し後の残高確認
      const walletBalanceAfter = await tokenContract.balanceOf(wallet.address);
      const withdrawnAmount = walletBalanceAfter - walletBalanceBefore;
      
      console.log(`✅ Withdrawal successful!`);
      console.log(`💵 Withdrawn: ${ethers.formatUnits(withdrawnAmount, 6)} USDC`);
      console.log(`💰 Your USDC balance after: ${ethers.formatUnits(walletBalanceAfter, 6)}`);
      console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);
      
    } else {
      console.log(`❌ Withdrawal transaction failed`);
    }
    
  } catch (error) {
    console.error("❌ Withdrawal failed:", error instanceof Error ? error.message : String(error));
  }
}

manualWithdraw(); 