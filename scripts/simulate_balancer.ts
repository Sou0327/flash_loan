import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

// 0x Protocol APIレスポンスの型定義
interface ZxPriceResponse {
  buyAmount?: string;
  sellAmount?: string;
  [key: string]: any;
}

interface ZxQuoteResponse {
  transaction?: {
    data: string;
    to: string;
    gas?: string;
    gasPrice?: string;
    value?: string;
  };
  buyAmount?: string;
  [key: string]: any;
}

async function main() {
  console.log("🧪 Balancer Flash Loan Simulation\n");

  // コントラクトアドレス
  const BALANCER_FLASH_ARB = process.env.BALANCER_FLASH_ARB!;
  const USDC = process.env.USDC || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const WETH = process.env.WETH || "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  
  // 借りる金額
  const amount = ethers.parseUnits("100000", 6); // 10万 USDC

  console.log(`📋 Simulation Parameters:`);
  console.log(`  - Flash Loan Amount: 100,000 USDC`);
  console.log(`  - Contract: ${BALANCER_FLASH_ARB}`);
  console.log(`  - Path: USDC -> WETH -> USDC`);

  // 0x Protocol API設定
  const apiKey = process.env.ZX_API_KEY!; // 0x APIキー
  const chainId = "1";
  
  // コントラクトインスタンス
  const abi = [
    "function executeFlashLoan(address[] tokens, uint256[] amounts, bytes userData) external",
    "function owner() view returns (address)",
    "event FlashLoanExecuted(address indexed token, uint256 amount, uint256 feeAmount, uint256 profit)"
  ];
  
  const flashArb = await ethers.getContractAt(abi, BALANCER_FLASH_ARB);
  
  // オーナー確認
  const [signer] = await ethers.getSigners();
  const owner = await flashArb.owner();
  console.log(`\n👤 Contract owner: ${owner}`);
  console.log(`👤 Current signer: ${signer.address}`);
  
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.error("❌ You are not the owner of the contract!");
    return;
  }

  // 0x Protocol APIからpriceを取得
  console.log(`\n🔍 Getting price from 0x Protocol...`);
  const priceParams = new URLSearchParams({
    chainId: chainId,
    sellToken: USDC,
    buyToken: WETH,
    sellAmount: amount.toString(),
    taker: BALANCER_FLASH_ARB
  });
  
  const priceResponse = await fetch(
    `https://api.0x.org/swap/permit2/price?${priceParams.toString()}`,
    {
      headers: { 
        '0x-api-key': apiKey,
        '0x-version': 'v2'
      },
    }
  );
  const priceData = await priceResponse.json() as ZxPriceResponse;
  
  if (!priceData.buyAmount) {
    console.error("❌ Failed to get price:", priceData);
    return;
  }

  console.log(`💱 Price received:`);
  console.log(`  - Input: ${ethers.formatUnits(amount, 6)} USDC`);
  console.log(`  - Output: ${ethers.formatUnits(priceData.buyAmount, 18)} WETH`);
  
  // Quote calldataを取得
  console.log(`\n📝 Getting quote calldata...`);
  const quoteParams = new URLSearchParams({
    chainId: chainId,
    sellToken: USDC,
    buyToken: WETH,
    sellAmount: amount.toString(),
    taker: BALANCER_FLASH_ARB,
    slippagePercentage: '0.01' // 1%スリッページ
  });
  
  const quoteResponse = await fetch(
    `https://api.0x.org/swap/permit2/quote?${quoteParams.toString()}`,
    {
      headers: { 
        '0x-api-key': apiKey,
        '0x-version': 'v2'
      },
    }
  );
  const quoteData = await quoteResponse.json() as ZxQuoteResponse;
  
  if (!quoteData.transaction) {
    console.error("❌ Failed to get quote data:", quoteData);
    return;
  }

  // フラッシュローンを実行
  console.log(`\n🚀 Executing Balancer flash loan...`);
  const tokens = [USDC];
  const amounts = [amount];
  
  try {
    const tx = await flashArb.executeFlashLoan(
      tokens,
      amounts,
      quoteData.transaction.data,
      {
        gasLimit: 800000n // Balancerは少し多めのガスが必要
      }
    );
    console.log(`📜 Transaction hash: ${tx.hash}`);
    
    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
    console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);
    
    // イベントログを解析
    console.log(`\n📊 Transaction events:`);
    for (const log of receipt.logs) {
      try {
        const parsed = flashArb.interface.parseLog({
          topics: log.topics as string[],
          data: log.data
        });
        
        if (parsed?.name === "FlashLoanExecuted") {
          console.log(`\n💰 Flash Loan Executed:`);
          console.log(`  - Token: ${parsed.args.token}`);
          console.log(`  - Amount: ${ethers.formatUnits(parsed.args.amount, 6)} USDC`);
          console.log(`  - Fee: ${ethers.formatUnits(parsed.args.feeAmount, 6)} USDC`);
          console.log(`  - Profit: ${ethers.formatUnits(parsed.args.profit, 6)} USDC`);
        }
      } catch {
        // 他のコントラクトのイベント
      }
    }
    
  } catch (error: any) {
    console.error(`\n❌ Transaction failed:`);
    console.error(error.message);
    
    // revert理由を取得
    if (error.data) {
      try {
        const decodedError = flashArb.interface.parseError(error.data);
        console.error(`Revert reason: ${decodedError?.name}`);
      } catch {
        console.error(`Raw error data: ${error.data}`);
      }
    }
  }
  
  // 最終残高確認
  const usdcContract = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"],
    USDC
  );
  const finalBalance = await usdcContract.balanceOf(BALANCER_FLASH_ARB);
  console.log(`\n💵 Final contract USDC balance: ${ethers.formatUnits(finalBalance, 6)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});