import { ethers } from 'ethers';
import { getGasConfig } from './config';

// ガス価格履歴の型定義
interface GasPriceHistory {
  baseFeePerGas: bigint[];
  gasUsedRatio: number[];
  oldestBlock: number;
  reward?: bigint[][];
}

// 動的ガス価格管理クラス
export class DynamicGasManager {
  private provider: ethers.JsonRpcProvider;
  private config: ReturnType<typeof getGasConfig>;
  private gasPriceHistory: number[] = [];
  private lastUpdateBlock: number = 0;

  constructor(provider: ethers.JsonRpcProvider) {
    this.provider = provider;
    this.config = getGasConfig();
  }

  /**
   * eth_feeHistoryを使用して動的ガス価格上限を計算（強化版）
   */
  async getDynamicGasCeiling(): Promise<number> {
    if (!this.config.dynamic_ceiling) {
      return this.config.max_price_gwei;
    }

    try {
      const currentBlock = await this.provider.getBlockNumber();
      
      // 1ブロックごとに更新（頻繁すぎない）
      if (currentBlock <= this.lastUpdateBlock) {
        return this.calculateCeiling();
      }

      // 過去20ブロックの履歴を取得（より精密な分析）
      const historyBlocks = Math.max(this.config.ceiling_blocks, 20);
      const feeHistory = await this.getFeeHistory(historyBlocks);
      
      if (feeHistory && feeHistory.baseFeePerGas.length > 0) {
        // baseFeePerGasをGweiに変換して履歴に追加
        const baseFeeGweiArray = feeHistory.baseFeePerGas.map(fee => 
          Number(ethers.formatUnits(fee, 'gwei'))
        );
        
        // 履歴を更新（最新のhistoryBlocks分のみ保持）
        this.gasPriceHistory = baseFeeGweiArray;
        this.lastUpdateBlock = currentBlock;
        
        console.log(`📊 Gas history updated: ${baseFeeGweiArray.length} blocks, latest: ${baseFeeGweiArray[baseFeeGweiArray.length - 1].toFixed(2)} Gwei`);
      }

      return this.calculateCeiling();

    } catch (error) {
      console.warn(`⚠️  Failed to get dynamic gas ceiling:`, error instanceof Error ? error.message : String(error));
      return this.config.max_price_gwei; // フォールバック
    }
  }

  /**
   * eth_feeHistoryを呼び出し
   */
  private async getFeeHistory(blockCount: number): Promise<GasPriceHistory | null> {
    try {
      // ethers.jsにはeth_feeHistoryの直接サポートがないため、直接RPCコール
      const result = await this.provider.send('eth_feeHistory', [
        `0x${blockCount.toString(16)}`, // ブロック数（16進数）
        'latest',                        // 最新ブロックから
        [25, 50, 75]                    // パーセンタイル（25%, 50%, 75%）
      ]);

      return {
        baseFeePerGas: result.baseFeePerGas.map((fee: string) => BigInt(fee)),
        gasUsedRatio: result.gasUsedRatio,
        oldestBlock: parseInt(result.oldestBlock, 16),
        reward: result.reward?.map((rewards: string[]) => 
          rewards.map((reward: string) => BigInt(reward))
        )
      };

    } catch (error) {
      console.warn(`⚠️  eth_feeHistory failed:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /**
   * 履歴データから動的上限を計算（統計的手法）
   */
  private calculateCeiling(): number {
    if (this.gasPriceHistory.length === 0) {
      return this.config.max_price_gwei;
    }

    // 平均と標準偏差を計算
    const mean = this.gasPriceHistory.reduce((sum, price) => sum + price, 0) / this.gasPriceHistory.length;
    const variance = this.gasPriceHistory.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / this.gasPriceHistory.length;
    const stdDev = Math.sqrt(variance);

    // 動的上限 = 平均 + (1σ * 係数) - より保守的なアプローチ
    const dynamicCeiling = mean + (stdDev * this.config.ceiling_multiplier);
    
    // 設定された最大値を超えないように制限
    const finalCeiling = Math.min(dynamicCeiling, this.config.max_price_gwei);
    
    // 最小値も設定（極端に低い値を防ぐ）
    const minCeiling = Math.max(finalCeiling, 5); // 最低5 Gwei

    console.log(`📊 Gas ceiling: ${minCeiling.toFixed(2)} Gwei (avg: ${mean.toFixed(2)}, σ: ${stdDev.toFixed(2)}, samples: ${this.gasPriceHistory.length})`);
    
    return minCeiling;
  }

  /**
   * 現在のガス価格が上限を超えているかチェック
   */
  async isGasPriceAcceptable(currentGasPriceGwei: number): Promise<boolean> {
    const ceiling = await this.getDynamicGasCeiling();
    return currentGasPriceGwei <= ceiling;
  }

  /**
   * 最適なガス価格を提案
   */
  async getOptimalGasPrice(): Promise<{
    gasPrice: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    isAcceptable: boolean;
  }> {
    try {
      const feeData = await this.provider.getFeeData();
      const ceiling = await this.getDynamicGasCeiling();
      const ceilingWei = ethers.parseUnits(ceiling.toString(), 'gwei');

      let gasPrice = feeData.gasPrice || BigInt(0);
      let maxFeePerGas = feeData.maxFeePerGas || BigInt(0);
      let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits(this.config.priority_fee_gwei.toString(), 'gwei');

      // 上限を超える場合は調整
      if (maxFeePerGas > ceilingWei) {
        maxFeePerGas = ceilingWei;
        console.log(`⚠️  Gas price capped at ${ceiling} Gwei`);
      }

      if (gasPrice > ceilingWei) {
        gasPrice = ceilingWei;
      }

      // maxPriorityFeePerGasがmaxFeePerGasを超えないように調整
      if (maxPriorityFeePerGas > maxFeePerGas) {
        maxPriorityFeePerGas = maxFeePerGas / BigInt(2); // 半分に設定
      }

      const currentGasPriceGwei = Number(ethers.formatUnits(maxFeePerGas, 'gwei'));
      const isAcceptable = currentGasPriceGwei <= ceiling;

      return {
        gasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
        isAcceptable
      };

    } catch (error) {
      console.error(`❌ Failed to get optimal gas price:`, error instanceof Error ? error.message : String(error));
      
      // フォールバック値
      const fallbackGasPrice = ethers.parseUnits(this.config.max_price_gwei.toString(), 'gwei');
      return {
        gasPrice: fallbackGasPrice,
        maxFeePerGas: fallbackGasPrice,
        maxPriorityFeePerGas: ethers.parseUnits(this.config.priority_fee_gwei.toString(), 'gwei'),
        isAcceptable: false
      };
    }
  }

  /**
   * ガス価格統計を取得
   */
  getGasStatistics(): {
    historyLength: number;
    averageGwei: number;
    minGwei: number;
    maxGwei: number;
    currentCeiling: number;
  } {
    if (this.gasPriceHistory.length === 0) {
      return {
        historyLength: 0,
        averageGwei: 0,
        minGwei: 0,
        maxGwei: 0,
        currentCeiling: this.config.max_price_gwei
      };
    }

    const average = this.gasPriceHistory.reduce((sum, price) => sum + price, 0) / this.gasPriceHistory.length;
    const min = Math.min(...this.gasPriceHistory);
    const max = Math.max(...this.gasPriceHistory);

    return {
      historyLength: this.gasPriceHistory.length,
      averageGwei: average,
      minGwei: min,
      maxGwei: max,
      currentCeiling: this.calculateCeiling()
    };
  }
} 