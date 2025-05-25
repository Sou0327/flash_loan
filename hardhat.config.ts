import * as dotenv from "dotenv";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-toolbox";

dotenv.config();

const { MAINNET_RPC, PRIVATE_KEY } = process.env;

export default {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      forking: {
        url: MAINNET_RPC || "",
        blockNumber: 19850000
      }
    },
    mainnet: {
      url: MAINNET_RPC || "",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
    },
    fork: {
      url: MAINNET_RPC || "",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
    }
  }
};