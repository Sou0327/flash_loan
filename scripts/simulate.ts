import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

/*
  fork ネットワークで FlashLoanArb.start() を1度呼んでシミュレーション。
  ここでは 1inch API から簡易 quote を取得し、その calldata を渡しています。
  実際には src/scanner.ts と同じロジックを流用して構いません。
*/
async function main() {
  const FLASH_ARB = process.env.FLASH_ARB!;          // デプロイ済みアドレス
  const USDC = process.env.USDC!;                    // USDC アドレス
  const amount = ethers.utils.parseUnits("100000", 6); // 10万 USDC

  // ------ 1inch Quote ------
  const apiKey = process.env.INCH_KEY!;
  const url =
    `https://api.1inch.dev/swap/v5.2/1/quote?src=${USDC}&dst=WETH&amount=${amount}`;
  const quote = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }).then((r) => r.json());

  const flashArb = await ethers.getContractAt("FlashLoanArb", FLASH_ARB);
  const tx = await flashArb.start(USDC, amount, quote.tx.data);
  console.log(`\n🧪 Simulation tx hash: ${tx.hash}`);
  await tx.wait();
  console.log("✅ Simulation finished (fork chain)");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});