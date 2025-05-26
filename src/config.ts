import convict from 'convict';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';

// YAML形式のサポートを追加
convict.addFormat({
  name: 'yaml',
  validate: function(val: any) {
    return typeof val === 'object';
  },
  coerce: function(val: any) {
    return val;
  }
});

// 設定スキーマ定義
const configSchema = {
  network: {
    mainnet_rpc: {
      doc: 'Mainnet RPC URL',
      format: String,
      default: '',
      env: 'MAINNET_RPC'
    },
    flashbots_rpc: {
      doc: 'Flashbots RPC URL',
      format: String,
      default: 'https://rpc.flashbots.net',
      env: 'FLASHBOTS_RPC'
    },
    use_flashbots: {
      doc: 'Use Flashbots for MEV protection',
      format: Boolean,
      default: true,
      env: 'USE_FLASHBOTS'
    },
    chain_id: {
      doc: 'Ethereum Chain ID',
      format: 'int',
      default: 1
    }
  },
  contracts: {
    balancer_flash_arb: {
      doc: 'Balancer Flash Arbitrage Contract Address',
      format: String,
      default: '',
      env: 'BALANCER_FLASH_ARB'
    },
    usdc: {
      doc: 'USDC Token Address',
      format: String,
      default: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      env: 'USDC'
    },
    weth: {
      doc: 'WETH Token Address',
      format: String,
      default: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      env: 'WETH'
    },
    dai: {
      doc: 'DAI Token Address',
      format: String,
      default: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      env: 'DAI'
    },
    usdt: {
      doc: 'USDT Token Address',
      format: String,
      default: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      env: 'USDT'
    },
    wbtc: {
      doc: 'WBTC Token Address',
      format: String,
      default: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
    }
  },
  amounts: {
    mainnet: {
      usdc: {
        doc: 'USDC borrow amount (mainnet)',
        format: String,
        default: '50000'
      },
      dai: {
        doc: 'DAI borrow amount (mainnet)',
        format: String,
        default: '50000'
      },
      weth: {
        doc: 'WETH borrow amount (mainnet)',
        format: String,
        default: '15'
      },
      wbtc: {
        doc: 'WBTC borrow amount (mainnet)',
        format: String,
        default: '1.5'
      }
    },
    fork: {
      usdc: {
        doc: 'USDC borrow amount (fork)',
        format: String,
        default: '1000'
      },
      dai: {
        doc: 'DAI borrow amount (fork)',
        format: String,
        default: '1000'
      },
      weth: {
        doc: 'WETH borrow amount (fork)',
        format: String,
        default: '0.5'
      },
      wbtc: {
        doc: 'WBTC borrow amount (fork)',
        format: String,
        default: '0.02'
      }
    }
  },
  gas: {
    limit: {
      doc: 'Gas limit for transactions',
      format: 'int',
      default: 400000
    },
    max_price_gwei: {
      doc: 'Maximum gas price in Gwei',
      format: Number,
      default: 25
    },
    priority_fee_gwei: {
      doc: 'Priority fee in Gwei',
      format: Number,
      default: 1.5
    },
    dynamic_ceiling: {
      doc: 'Use dynamic gas price ceiling',
      format: Boolean,
      default: true
    },
    ceiling_blocks: {
      doc: 'Number of blocks for gas price history',
      format: 'int',
      default: 10
    },
    ceiling_multiplier: {
      doc: 'Multiplier for dynamic gas ceiling',
      format: Number,
      default: 1.5
    }
  },
  profit: {
    mainnet: {
      min_percentage: {
        doc: 'Minimum profit percentage (mainnet)',
        format: Number,
        default: 0.2
      },
      min_amount_usd: {
        doc: 'Minimum profit amount in USD (mainnet)',
        format: Number,
        default: 100
      },
      gas_multiplier: {
        doc: 'Gas cost multiplier (mainnet)',
        format: Number,
        default: 2.0
      }
    },
    fork: {
      min_percentage: {
        doc: 'Minimum profit percentage (fork)',
        format: Number,
        default: 0.1
      },
      min_amount_usd: {
        doc: 'Minimum profit amount in USD (fork)',
        format: Number,
        default: 1
      },
      gas_multiplier: {
        doc: 'Gas cost multiplier (fork)',
        format: Number,
        default: 1.5
      }
    }
  },
  execution: {
    check_interval_blocks: {
      doc: 'Block interval for checking arbitrage',
      format: 'int',
      default: 3
    },
    max_slippage: {
      doc: 'Maximum slippage percentage',
      format: Number,
      default: 1.0
    }
  },
  monitoring: {
    block_interval: {
      doc: 'Block interval for monitoring',
      format: 'int',
      default: 3
    },
    max_slippage_percent: {
      doc: 'Maximum slippage percentage for monitoring',
      format: Number,
      default: 0.5
    }
  },
  auto_withdraw: {
    enabled: {
      doc: 'Enable auto withdrawal',
      format: Boolean,
      default: false,
      env: 'AUTO_WITHDRAW_ENABLED'
    },
    threshold_usd: {
      doc: 'Auto withdrawal threshold in USD',
      format: Number,
      default: 1000,
      env: 'AUTO_WITHDRAW_THRESHOLD'
    },
    token: {
      doc: 'Auto withdrawal token',
      format: String,
      default: 'usdc',
      env: 'AUTO_WITHDRAW_TOKEN'
    }
  },
  api: {
    zx_api_key: {
      doc: '0x Protocol API Key',
      format: String,
      default: '',
      env: 'ZX_API_KEY',
      sensitive: true
    },
    oneinch_api_key: {
      doc: '1inch API Key',
      format: String,
      default: '',
      env: 'ONEINCH_API_KEY',
      sensitive: true
    }
  },
  redis: {
    enabled: {
      doc: 'Enable Redis cache',
      format: Boolean,
      default: false,
      env: 'REDIS_ENABLED'
    },
    host: {
      doc: 'Redis host',
      format: String,
      default: 'localhost',
      env: 'REDIS_HOST'
    },
    port: {
      doc: 'Redis port',
      format: 'port',
      default: 6379,
      env: 'REDIS_PORT'
    },
    password: {
      doc: 'Redis password',
      format: String,
      default: '',
      env: 'REDIS_PASSWORD',
      sensitive: true
    },
    ttl_seconds: {
      doc: 'Redis TTL in seconds',
      format: 'int',
      default: 30
    }
  },
  metrics: {
    enabled: {
      doc: 'Enable metrics server',
      format: Boolean,
      default: false,
      env: 'METRICS_ENABLED'
    },
    port: {
      doc: 'Metrics server port',
      format: 'port',
      default: 3001,
      env: 'METRICS_PORT'
    },
    auth_user: {
      doc: 'Metrics auth username',
      format: String,
      default: 'admin',
      env: 'METRICS_AUTH_USER'
    },
    auth_pass: {
      doc: 'Metrics auth password',
      format: String,
      default: 'changeme',
      env: 'METRICS_AUTH_PASS',
      sensitive: true
    },
    allowed_ips: {
      doc: 'Allowed IPs for metrics',
      format: Array,
      default: ['127.0.0.1', '::1'],
      env: 'METRICS_ALLOWED_IPS'
    }
  },
  permit2: {
    enabled: {
      doc: 'Enable Permit2 signatures',
      format: Boolean,
      default: false
    },
    contract: {
      doc: 'Permit2 contract address',
      format: String,
      default: '0x000000000022D473030F116dDEE9F6B43aC78BA3'
    },
    expiration_seconds: {
      doc: 'Permit2 expiration in seconds',
      format: 'int',
      default: 600
    }
  }
};

// 設定インスタンスを作成
const config = convict(configSchema);

// YAML設定ファイルを読み込み
const configPath = path.join(process.cwd(), 'config.yaml');
if (fs.existsSync(configPath)) {
  const yamlContent = fs.readFileSync(configPath, 'utf8');
  const yamlConfig = yaml.load(yamlContent) as any;
  config.load(yamlConfig);
}

// 環境変数を読み込み（優先度最高）
config.load({});

// バリデーション実行
config.validate({ allowed: 'strict' });

// 型安全なヘルパー関数
export const getConfig = () => config.getProperties();

export const getNetworkConfig = () => config.get('network');
export const getContractsConfig = () => config.get('contracts');
export const getGasConfig = () => config.get('gas');
export const getProfitConfig = () => config.get('profit');
export const getExecutionConfig = () => config.get('execution');
export const getMonitoringConfig = () => config.get('monitoring');
export const getAutoWithdrawConfig = () => config.get('auto_withdraw');
export const getApiConfig = () => config.get('api');
export const getRedisConfig = () => config.get('redis');
export const getMetricsConfig = () => config.get('metrics');
export const getPermit2Config = () => config.get('permit2');

// 環境検出
export const isForkedEnvironment = (rpcUrl: string): boolean => {
  return (rpcUrl?.includes('127.0.0.1') || rpcUrl?.includes('localhost')) && 
         !rpcUrl?.includes('alchemy.com');
};

// 借入額取得（環境別）
export const getBorrowAmounts = (isFork: boolean) => {
  const amounts = isFork ? config.get('amounts.fork') : config.get('amounts.mainnet');
  const contracts = getContractsConfig();
  
  return {
    USDC: ethers.parseUnits(amounts.usdc, 6),
    DAI: ethers.parseUnits(amounts.dai, 18),
    WETH: ethers.parseUnits(amounts.weth, 18),
    WBTC: ethers.parseUnits(amounts.wbtc, 8),
  };
};

// 利益設定取得（環境別）
export const getProfitSettings = (isFork: boolean) => {
  return isFork ? config.get('profit.fork') : config.get('profit.mainnet');
};

// 設定の妥当性チェック
export const validateConfig = (): string[] => {
  const errors: string[] = [];
  
  const networkConfig = getNetworkConfig();
  const apiConfig = getApiConfig();
  
  if (!networkConfig.mainnet_rpc) {
    errors.push('MAINNET_RPC is required');
  }
  
  if (!apiConfig.zx_api_key) {
    errors.push('ZX_API_KEY is required');
  }
  
  return errors;
};

export default config; 