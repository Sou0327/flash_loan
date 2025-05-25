import * as dotenv from "dotenv";
import "@nomicfoundation/hardhat-ethers";
dotenv.config();

const { MAINNET_RPC, PRIVATE_KEY } = process.env;

export default {
  defaultNetwork: "mainnet",
  networks: {
    mainnet: {
      url: MAINNET_RPC,
      accounts: [PRIVATE_KEY!],
    },
    fork: {
      url: MAINNET_RPC,
      forking: { blockNumber: 19850000 },
    },
  },
  solidity: "0.8.20",
};
