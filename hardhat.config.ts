import * as dotenv from "dotenv";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-toolbox";

dotenv.config();

const { MAINNET_RPC, ALCHEMY_WSS, PRIVATE_KEY } = process.env;
const RPC_URL = MAINNET_RPC || ALCHEMY_WSS?.replace('wss://', 'https://') || "";

// テスト用のプライベートキー（実際のキーが無効な場合）
const TEST_PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const VALID_PRIVATE_KEY = PRIVATE_KEY && PRIVATE_KEY.length === 66 ? PRIVATE_KEY : TEST_PRIVATE_KEY;

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
        url: RPC_URL,
        blockNumber: 19850000
      }
    },
    mainnet: {
      url: RPC_URL,
      accounts: [VALID_PRIVATE_KEY]
    },
    fork: {
      url: RPC_URL,
      accounts: [VALID_PRIVATE_KEY]
    }
  }
};