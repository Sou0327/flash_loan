import fetch from "node-fetch";
import * as dotenv from "dotenv";
dotenv.config();

async function testAPI() {
  console.log("🔍 Testing updated 0x API...");
  
  const apiKey = process.env.ZX_API_KEY;
  if (!apiKey) {
    console.error("❌ ZX_API_KEY not found");
    return;
  }
  
  console.log(`🔑 API Key: ${apiKey.substring(0, 8)}...`);
  
  try {
    // Permit2 Price APIをテスト
    const response = await fetch(
      "https://api.0x.org/swap/permit2/price?chainId=1&sellToken=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&buyToken=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2&sellAmount=1000000",
      {
        headers: { 
          '0x-api-key': apiKey,
          '0x-version': 'v2'
        }
      }
    );
    
    console.log(`📡 Status: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json() as any;
      console.log("✅ API Success!");
      console.log(`💰 Buy Amount: ${data.buyAmount}`);
      console.log(`📈 Price: ${data.price}`);
    } else {
      const errorText = await response.text();
      console.log(`❌ API Error: ${errorText}`);
    }
    
  } catch (error) {
    console.error("❌ Request failed:", error);
  }
}

testAPI(); 