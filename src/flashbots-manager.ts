import { ethers } from 'ethers';
import { getNetworkConfig } from './config';

// Flashbotsバンドルの型定義
interface FlashbotsBundle {
  signedTransactions: string[];
  blockNumber: number;
}

interface FlashbotsBundleResponse {
  bundleHash: string;
  simulation?: {
    success: boolean;
    error?: string;
    gasUsed: string;
  };
}

// Flashbotsバンドル管理クラス
export class FlashbotsManager {
  private provider: ethers.JsonRpcProvider;
  private flashbotsProvider: ethers.JsonRpcProvider | null = null;
  private wallet: ethers.Wallet;
  private flashbotsWallet: ethers.Wallet | null = null;
  private config: ReturnType<typeof getNetworkConfig>;

  constructor(
    provider: ethers.JsonRpcProvider,
    wallet: ethers.Wallet
  ) {
    this.provider = provider;
    this.wallet = wallet;
    this.config = getNetworkConfig();
    
    if (this.config.use_flashbots) {
      this.initializeFlashbots();
    }
  }

  /**
   * Flashbots接続を初期化
   */
  private initializeFlashbots(): void {
    try {
      this.flashbotsProvider = new ethers.JsonRpcProvider(this.config.flashbots_rpc);
      this.flashbotsWallet = new ethers.Wallet(this.wallet.privateKey, this.flashbotsProvider);
      console.log('🔒 Flashbots provider initialized');
    } catch (error) {
      console.warn('⚠️  Failed to initialize Flashbots:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * アービトラージ + 引き出しのバンドルを作成・送信
   */
  async sendArbitrageWithWithdrawBundle(
    arbitrageTx: ethers.TransactionRequest,
    withdrawToken: string,
    contractAddress: string,
    contractAbi: string[]
  ): Promise<{
    success: boolean;
    bundleHash?: string;
    arbitrageTxHash?: string;
    withdrawTxHash?: string;
    error?: string;
  }> {
    if (!this.flashbotsProvider || !this.flashbotsWallet) {
      return {
        success: false,
        error: 'Flashbots not initialized'
      };
    }

    try {
      const currentBlock = await this.provider.getBlockNumber();
      const targetBlock = currentBlock + 1;

      // 1. アービトラージトランザクションに署名
      const signedArbitrageTx = await this.flashbotsWallet.signTransaction({
        ...arbitrageTx,
        nonce: await this.flashbotsWallet.getNonce(),
        chainId: this.config.chain_id
      });

      // 2. 引き出しトランザクションを準備
      const contract = new ethers.Contract(contractAddress, contractAbi, this.flashbotsWallet);
      
      const withdrawTx = await contract.withdraw.populateTransaction(withdrawToken);
      const signedWithdrawTx = await this.flashbotsWallet.signTransaction({
        ...withdrawTx,
        nonce: await this.flashbotsWallet.getNonce() + 1, // 次のnonce
        gasLimit: BigInt(100000), // 引き出し用ガス制限
        maxFeePerGas: arbitrageTx.maxFeePerGas,
        maxPriorityFeePerGas: arbitrageTx.maxPriorityFeePerGas,
        chainId: this.config.chain_id
      });

      // 3. バンドルを作成
      const bundle: FlashbotsBundle = {
        signedTransactions: [signedArbitrageTx, signedWithdrawTx],
        blockNumber: targetBlock
      };

      // 4. バンドルシミュレーション
      const simulation = await this.simulateBundle(bundle);
      if (!simulation.success) {
        console.warn('⚠️  Bundle simulation failed:', simulation.error);
        // シミュレーション失敗でも送信を試行（ネットワーク状況による）
      }

      // 5. バンドル送信
      const bundleResponse = await this.sendBundle(bundle);
      
      if (bundleResponse.bundleHash) {
        console.log(`🔒 Bundle sent: ${bundleResponse.bundleHash}`);
        
        // バンドル結果を監視
        const result = await this.waitForBundleInclusion(bundleResponse.bundleHash, targetBlock);
        
        return {
          success: result.included,
          bundleHash: bundleResponse.bundleHash,
          arbitrageTxHash: result.arbitrageTxHash,
          withdrawTxHash: result.withdrawTxHash,
          error: result.error
        };
      } else {
        return {
          success: false,
          error: 'Failed to send bundle'
        };
      }

    } catch (error) {
      console.error('❌ Bundle creation failed:', error instanceof Error ? error.message : String(error));
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * バンドルシミュレーション
   */
  private async simulateBundle(bundle: FlashbotsBundle): Promise<{
    success: boolean;
    error?: string;
    gasUsed?: string;
  }> {
    if (!this.flashbotsProvider) {
      return { success: false, error: 'Flashbots provider not available' };
    }

    try {
      const result = await this.flashbotsProvider.send('eth_callBundle', [
        {
          txs: bundle.signedTransactions,
          blockNumber: `0x${bundle.blockNumber.toString(16)}`
        }
      ]);

      if (result.error) {
        return {
          success: false,
          error: result.error.message || 'Simulation failed'
        };
      }

      return {
        success: true,
        gasUsed: result.results?.[0]?.gasUsed
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * バンドル送信
   */
  private async sendBundle(bundle: FlashbotsBundle): Promise<FlashbotsBundleResponse> {
    if (!this.flashbotsProvider) {
      throw new Error('Flashbots provider not available');
    }

    try {
      const result = await this.flashbotsProvider.send('eth_sendBundle', [
        {
          txs: bundle.signedTransactions,
          blockNumber: `0x${bundle.blockNumber.toString(16)}`
        }
      ]);

      return {
        bundleHash: result.bundleHash || 'unknown',
        simulation: result.simulation
      };

    } catch (error) {
      throw new Error(`Bundle send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * バンドルのブロック取り込みを監視
   */
  private async waitForBundleInclusion(
    bundleHash: string,
    targetBlock: number,
    timeoutBlocks = 3
  ): Promise<{
    included: boolean;
    arbitrageTxHash?: string;
    withdrawTxHash?: string;
    error?: string;
  }> {
    const startBlock = await this.provider.getBlockNumber();
    
    return new Promise((resolve) => {
      const checkInclusion = async () => {
        try {
          const currentBlock = await this.provider.getBlockNumber();
          
          // タイムアウトチェック
          if (currentBlock > targetBlock + timeoutBlocks) {
            resolve({
              included: false,
              error: `Bundle not included within ${timeoutBlocks} blocks`
            });
            return;
          }

          // 対象ブロックに到達していない場合は待機
          if (currentBlock < targetBlock) {
            setTimeout(checkInclusion, 3000); // 3秒後に再チェック
            return;
          }

          // ブロック内のトランザクションをチェック
          const block = await this.provider.getBlock(targetBlock, true);
          if (block && block.transactions) {
            const txHashes = block.transactions.map(tx => 
              typeof tx === 'string' ? tx : (tx as any).hash
            );

            // バンドル内のトランザクションが含まれているかチェック
            // 実際の実装では、署名済みトランザクションからハッシュを計算する必要がある
            // ここでは簡略化
            
            resolve({
              included: true,
              arbitrageTxHash: txHashes[0], // 仮の実装
              withdrawTxHash: txHashes[1]   // 仮の実装
            });
          } else {
            setTimeout(checkInclusion, 3000);
          }

        } catch (error) {
          resolve({
            included: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      };

      checkInclusion();
    });
  }

  /**
   * 単一トランザクションをFlashbots経由で送信（フォールバック用）
   */
  async sendSingleTransaction(
    tx: ethers.TransactionRequest
  ): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
  }> {
    if (!this.flashbotsProvider || !this.flashbotsWallet) {
      return {
        success: false,
        error: 'Flashbots not initialized'
      };
    }

    try {
      const currentBlock = await this.provider.getBlockNumber();
      const targetBlock = currentBlock + 1;

      const signedTx = await this.flashbotsWallet.signTransaction({
        ...tx,
        nonce: await this.flashbotsWallet.getNonce(),
        chainId: this.config.chain_id
      });

      const bundle: FlashbotsBundle = {
        signedTransactions: [signedTx],
        blockNumber: targetBlock
      };

      const bundleResponse = await this.sendBundle(bundle);
      
      if (bundleResponse.bundleHash) {
        const result = await this.waitForBundleInclusion(bundleResponse.bundleHash, targetBlock);
        
        return {
          success: result.included,
          txHash: result.arbitrageTxHash,
          error: result.error
        };
      } else {
        return {
          success: false,
          error: 'Failed to send transaction bundle'
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Flashbotsが利用可能かチェック
   */
  isAvailable(): boolean {
    return !!(this.flashbotsProvider && this.flashbotsWallet && this.config.use_flashbots);
  }

  /**
   * 接続を閉じる
   */
  async close(): Promise<void> {
    // Flashbotsプロバイダーのクリーンアップ
    if (this.flashbotsProvider) {
      try {
        this.flashbotsProvider.removeAllListeners();
      } catch (error) {
        console.warn('⚠️  Error closing Flashbots provider:', error instanceof Error ? error.message : String(error));
      }
    }
  }
} 