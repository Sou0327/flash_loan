import { ethers } from "ethers";
import fetch from "node-fetch";
import * as dotenv from "dotenv";
dotenv.config();

// フォーク環境の設定
const FORK_RPC_URL = process.env.MAINNET_RPC || "http://127.0.0.1:8545";
const provider = new ethers.JsonRpcProvider(FORK_RPC_URL);

// フォーク環境のテストアカウント
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const wallet = new ethers.Wallet(TEST_PRIVATE_KEY, provider);

// フォーク環境でデプロイされたコントラクト
const FORK_CONTRACT_ADDRESS = process.env.BALANCER_FLASH_ARB || process.env.FORK_CONTRACT_ADDRESS || "0xfb6dAB6200b8958C2655C3747708F82243d3F32E";

// トークンアドレス
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

// ABI
const abi = [
  "function executeFlashLoan(address[] tokens, uint256[] amounts, bytes userData) external",
  "function owner() view returns (address)",
  "function withdraw(address token) external"
];

const flashArb = new ethers.Contract(FORK_CONTRACT_ADDRESS, abi, wallet);

// 0x Protocol API設定
const apiKey = process.env.ZX_API_KEY!;
const chainId = "1";

// テスト設定
const TEST_CONFIG = {
  AMOUNTS: {
    USDC: ethers.parseUnits("1000", 6),   // 1000 USDC
    WETH: ethers.parseUnits("0.5", 18),   // 0.5 WETH
    DAI: ethers.parseUnits("1000", 18),   // 1000 DAI
  },
  GAS: {
    LIMIT: 400000n,
    MAX_PRICE_GWEI: 50, // フォーク環境では高めに設定
  }
};

// 0x APIでスワップパスをチェック
async function checkSwapPath(
  fromToken: string,
  toToken: string,
  amount: bigint
): Promise<{ toAmount: bigint; calldata: string; target: string } | null> {
  try {
    console.log(`🔍 Checking swap: ${amount.toString()} tokens`);
    
    // Price取得
    const priceParams = new URLSearchParams({
      chainId: chainId,
      sellToken: fromToken,
      buyToken: toToken,
      sellAmount: amount.toString()
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
    
    if (!priceResponse.ok) {
      console.log(`❌ Price API failed: ${priceResponse.status}`);
      return null;
    }
    
    const priceData = await priceResponse.json() as any;
    console.log(`💰 Expected output: ${priceData.buyAmount}`);
    
    // Quote取得
    const quoteParams = new URLSearchParams({
      chainId: chainId,
      sellToken: fromToken,
      buyToken: toToken,
      sellAmount: amount.toString(),
      taker: FORK_CONTRACT_ADDRESS,
      slippagePercentage: "0.01" // 1%
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
    
    if (!quoteResponse.ok) {
      console.log(`❌ Quote API failed: ${quoteResponse.status}`);
      return null;
    }
    
    const quoteData = await quoteResponse.json() as any;
    
    return {
      toAmount: BigInt(priceData.buyAmount),
      calldata: quoteData.transaction.data,
      target: quoteData.transaction.to
    };
  } catch (error) {
    console.error(`❌ API Error:`, error);
    return null;
  }
}

// フォーク環境でのテスト実行
async function testArbitrage() {
  console.log("🧪 === FORK ENVIRONMENT TEST ===");
  console.log(`📍 Contract: ${FORK_CONTRACT_ADDRESS}`);
  console.log(`👤 Wallet: ${wallet.address}`);
  
  // 残高確認
  const balance = await provider.getBalance(wallet.address);
  console.log(`💰 ETH Balance: ${ethers.formatEther(balance)} ETH`);
  
  // コントラクトオーナー確認
  const owner = await flashArb.owner();
  console.log(`👑 Contract Owner: ${owner}`);
  
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error("❌ Wallet is not the contract owner!");
    return;
  }
  
  console.log("\n🔍 Testing USDC -> WETH -> USDC arbitrage...");
  
  try {
    // 1. USDC -> WETH
    console.log("Step 1: USDC -> WETH");
    const firstSwap = await checkSwapPath(USDC, WETH, TEST_CONFIG.AMOUNTS.USDC);
    
    if (!firstSwap) {
      console.error("❌ First swap failed");
      return;
    }
    
    console.log(`✅ First swap: ${ethers.formatUnits(firstSwap.toAmount, 18)} WETH`);
    
    // 2. WETH -> USDC
    console.log("Step 2: WETH -> USDC");
    const secondSwap = await checkSwapPath(WETH, USDC, firstSwap.toAmount);
    
    if (!secondSwap) {
      console.error("❌ Second swap failed");
      return;
    }
    
    console.log(`✅ Second swap: ${ethers.formatUnits(secondSwap.toAmount, 6)} USDC`);
    
    // 利益計算
    const borrowed = Number(TEST_CONFIG.AMOUNTS.USDC) / 1e6;
    const returned = Number(secondSwap.toAmount) / 1e6;
    const profit = returned - borrowed;
    const percentage = (profit / borrowed) * 100;
    
    console.log(`\n📊 Results:`);
    console.log(`   - Borrowed: ${borrowed} USDC`);
    console.log(`   - Returned: ${returned} USDC`);
    console.log(`   - Profit: ${profit.toFixed(6)} USDC (${percentage.toFixed(4)}%)`);
    
    if (percentage > 0.1) {
      console.log(`\n🚀 Executing test transaction...`);
      
      // userDataを作成
      const userData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes", "address", "bytes"],
        [firstSwap.target, firstSwap.calldata, secondSwap.target, secondSwap.calldata]
      );
      
      // フラッシュローン実行
      const tx = await flashArb.executeFlashLoan(
        [USDC],
        [TEST_CONFIG.AMOUNTS.USDC],
        userData,
        {
          gasLimit: TEST_CONFIG.GAS.LIMIT
        }
      );
      
      console.log(`📜 Transaction sent: ${tx.hash}`);
      
      const receipt = await tx.wait();
      
      if (receipt.status === 1) {
        console.log(`✅ Test transaction successful!`);
        console.log(`   - Block: ${receipt.blockNumber}`);
        console.log(`   - Gas used: ${receipt.gasUsed.toString()}`);
      } else {
        console.log(`❌ Test transaction failed`);
      }
      
    } else {
      console.log(`⚠️  Profit too low for execution (${percentage.toFixed(4)}%)`);
    }
    
  } catch (error) {
    console.error(`❌ Test failed:`, error);
  }
}

// メイン実行
async function main() {
  try {
    await testArbitrage();
  } catch (error) {
    console.error("Fatal error:", error);
  }
}

main(); 