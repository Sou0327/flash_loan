import { ethers } from "ethers";
import fetch from "node-fetch";
import * as dotenv from "dotenv";
dotenv.config();

// 設定
const RPC_URL = process.env.MAINNET_RPC || "http://127.0.0.1:8545";
const provider = new ethers.JsonRpcProvider(RPC_URL);
const apiKey = process.env.ZX_API_KEY!;

// トークンアドレス
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

async function testArbitrageDetection() {
  console.log("🔍 Testing Arbitrage Detection...");
  
  const testAmount = ethers.parseUnits("1000", 6); // 1000 USDC
  
  try {
    // 1. USDC -> WETH
    console.log("\n📊 Step 1: USDC -> WETH");
    const response1 = await fetch(
      `https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${USDC}&buyToken=${WETH}&sellAmount=${testAmount}`,
      {
        headers: { 
          '0x-api-key': apiKey,
          '0x-version': 'v2'
        }
      }
    );
    
    if (!response1.ok) {
      console.log(`❌ First swap failed: ${response1.status}`);
      return;
    }
    
    const data1 = await response1.json() as any;
    const wethAmount = BigInt(data1.buyAmount);
    console.log(`💰 Received: ${ethers.formatEther(wethAmount)} WETH`);
    
    // 2. WETH -> USDC (back)
    console.log("\n📊 Step 2: WETH -> USDC");
    const response2 = await fetch(
      `https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${WETH}&buyToken=${USDC}&sellAmount=${wethAmount}`,
      {
        headers: { 
          '0x-api-key': apiKey,
          '0x-version': 'v2'
        }
      }
    );
    
    if (!response2.ok) {
      console.log(`❌ Second swap failed: ${response2.status}`);
      return;
    }
    
    const data2 = await response2.json() as any;
    const finalUsdcAmount = BigInt(data2.buyAmount);
    console.log(`💰 Received: ${ethers.formatUnits(finalUsdcAmount, 6)} USDC`);
    
    // 3. 利益計算
    const profit = Number(finalUsdcAmount) - Number(testAmount);
    const profitPercentage = (profit / Number(testAmount)) * 100;
    
    console.log("\n📈 Results:");
    console.log(`💵 Initial: ${ethers.formatUnits(testAmount, 6)} USDC`);
    console.log(`💵 Final: ${ethers.formatUnits(finalUsdcAmount, 6)} USDC`);
    console.log(`💰 Profit: ${(profit / 1e6).toFixed(6)} USDC`);
    console.log(`📊 Percentage: ${profitPercentage.toFixed(4)}%`);
    
    if (profitPercentage > 0) {
      console.log("✅ Arbitrage opportunity detected!");
    } else {
      console.log("❌ No profitable arbitrage");
    }
    
  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

testArbitrageDetection(); 