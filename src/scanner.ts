import { ethers } from "ethers";
import fetch from "node-fetch";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.WebSocketProvider(process.env.ALCHEMY_WSS!);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const flashArb = new ethers.Contract(
  process.env.FLASH_ARB!,
  [
    "function start(address,uint256,bytes) external"
  ],
  signer
);
const USDC = process.env.USDC!;
const AMOUNT = ethers.utils.parseUnits("100000", 6); // 10万 USDC

provider.on("block", async () => {
  try {
    const apiKey = process.env.INCH_KEY!;
    const url =
      `https://api.1inch.dev/swap/v5.2/1/quote?src=${USDC}&dst=WETH&amount=${AMOUNT}`;
    const quote = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }).then((r) => r.json());

    const diff = Number(quote.toTokenAmount) / 1e18 - Number(quote.fromTokenAmount) / 1e6;
    if (diff / (Number(quote.fromTokenAmount) / 1e6) > 0.002) {
      const gas = await signer.getFeeData();
      if (Number(gas.maxFeePerGas) / 1e9 < 160) {
        const tx = await flashArb.start(USDC, AMOUNT, quote.tx.data, {
          maxFeePerGas: gas.maxFeePerGas,
          maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
        });
        console.log(`Arb sent: ${tx.hash}`);
      }
    }
  } catch (e) {
    console.error("[scanner]", e);
  }
});