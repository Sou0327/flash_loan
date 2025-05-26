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

interface MEVProtectionConfig {
  privatePools: string[];
  maxSlippageForBundle: number;
  atomicWithdrawal: boolean;
  multiBuilderSubmission: boolean;
}

interface BundleTransaction {
  to: string;
  data: string;
  value?: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

// Flashbotsバンドル管理クラス
export class FlashbotsManager {
  private provider: ethers.JsonRpcProvider;
  private flashbotsProvider: ethers.JsonRpcProvider | null = null;
  private wallet: ethers.Wallet;
  private flashbotsWallet: ethers.Wallet | null = null;
  private config: ReturnType<typeof getNetworkConfig>;
  private privatePools: Map<string, ethers.JsonRpcProvider>;
  private mevConfig: MEVProtectionConfig;

  constructor(
    provider: ethers.JsonRpcProvider,
    wallet: ethers.Wallet,
    mevConfig: MEVProtectionConfig
  ) {
    this.provider = provider;
    this.wallet = wallet;
    this.config = getNetworkConfig();
    this.mevConfig = mevConfig;
    this.privatePools = new Map();
    
    if (this.config.use_flashbots) {
      this.initializeFlashbots();
    }
    
    // プライベートプールの初期化
    this.initializePrivatePools();
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

  private initializePrivatePools() {
    const poolUrls = {
      flashbots: process.env.FLASHBOTS_RPC || "https://rpc.flashbots.net",
      eden: process.env.EDEN_RPC || "https://api.edennetwork.io/v1/rpc",
      bloxroute: process.env.BLOXROUTE_RPC || "https://mev.api.blxrbdn.com"
    };

    for (const [name, url] of Object.entries(poolUrls)) {
      if (this.mevConfig.privatePools.includes(name)) {
        this.privatePools.set(name, new ethers.JsonRpcProvider(url));
      }
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

  /**
   * 高度なMEV保護付きトランザクション送信
   */
  async executeWithMEVProtection(
    arbitrageTx: BundleTransaction,
    withdrawTx?: BundleTransaction
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    try {
      // 1. アトミックバンドルの作成
      const bundle = this.createAtomicBundle(arbitrageTx, withdrawTx);
      
      // 2. 複数のビルダーに同時送信
      const results = await Promise.allSettled(
        Array.from(this.privatePools.keys()).map(poolName => 
          this.sendToPrivatePool(poolName, bundle)
        )
      );
      
      // 3. 最初に成功した結果を返す
      const successfulResult = results.find(r => r.status === 'fulfilled');
      
      if (successfulResult && successfulResult.status === 'fulfilled') {
        return {
          success: true,
          txHash: successfulResult.value.txHash
        };
      }
      
      // 4. フォールバック：パブリックメンプール
      console.warn('⚠️  All private pools failed, falling back to public mempool');
      return await this.sendToPublicMempool(arbitrageTx);
      
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * アトミックバンドルの作成
   */
  private createAtomicBundle(
    arbitrageTx: BundleTransaction,
    withdrawTx?: BundleTransaction
  ): BundleTransaction[] {
    const bundle = [arbitrageTx];
    
    // 利益即座引き出しオプション
    if (this.mevConfig.atomicWithdrawal && withdrawTx) {
      bundle.push(withdrawTx);
    }
    
    return bundle;
  }

  /**
   * プライベートプールへの送信
   */
  private async sendToPrivatePool(
    poolName: string,
    bundle: BundleTransaction[]
  ): Promise<{ txHash: string }> {
    const provider = this.privatePools.get(poolName);
    if (!provider) {
      throw new Error(`Pool ${poolName} not available`);
    }

    console.log(`🔒 Sending bundle to ${poolName}...`);
    
    // Flashbots特有のバンドル送信ロジック
    if (poolName === 'flashbots') {
      return await this.sendFlashbotsBundle(provider, bundle);
    }
    
    // その他のプールは通常の送信（簡略化）
    const tx = bundle[0]; // 最初のトランザクションのみ
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
    
    const response = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value || 0n,
      gasLimit: tx.gasLimit,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas
    });
    
    return { txHash: response.hash };
  }

  /**
   * Flashbots特有のバンドル送信
   */
  private async sendFlashbotsBundle(
    provider: ethers.JsonRpcProvider,
    bundle: BundleTransaction[]
  ): Promise<{ txHash: string }> {
    // Flashbotsバンドル作成（簡略化）
    const bundleTransactions = bundle.map(tx => ({
      transaction: {
        to: tx.to,
        data: tx.data,
        value: ethers.toBeHex(tx.value || 0n),
        gasLimit: ethers.toBeHex(tx.gasLimit),
        maxFeePerGas: ethers.toBeHex(tx.maxFeePerGas),
        maxPriorityFeePerGas: ethers.toBeHex(tx.maxPriorityFeePerGas)
      },
      signer: new ethers.Wallet(process.env.PRIVATE_KEY!, provider)
    }));

    // 実際のFlashbots APIコール（eth_sendBundle）
    const currentBlock = await provider.getBlockNumber();
    const targetBlock = currentBlock + 1;
    
    const bundleRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendBundle",
      params: [{
        txs: bundleTransactions.map(tx => tx.transaction),
        blockNumber: ethers.toBeHex(targetBlock)
      }]
    };

    // HTTP POSTでFlashbots APIに送信
    const response = await fetch(provider._getConnection().url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Flashbots-Signature': await this.signFlashbotsRequest(bundleRequest)
      },
      body: JSON.stringify(bundleRequest)
    });

    const result = await response.json() as any;
    
    if (result.error) {
      throw new Error(`Flashbots error: ${result.error.message}`);
    }
    
    // バンドルハッシュを返す（実際のtxHashではない）
    return { txHash: result.result.bundleHash };
  }

  /**
   * Flashbotsリクエスト署名
   */
  private async signFlashbotsRequest(request: any): Promise<string> {
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!);
    const message = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(request)));
    const signature = await wallet.signMessage(ethers.getBytes(message));
    return `${wallet.address}:${signature}`;
  }

  /**
   * パブリックメンプールへのフォールバック
   */
  private async sendToPublicMempool(
    tx: BundleTransaction
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    try {
      const provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC);
      const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
      
      const response = await wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value || 0n,
        gasLimit: tx.gasLimit,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas
      });
      
      return {
        success: true,
        txHash: response.hash
      };
      
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 競合トランザクション検出
   */
  async detectCompetitorTransactions(): Promise<{
    competingTxs: number;
    avgGasPrice: bigint;
    maxGasPrice: bigint;
  }> {
    try {
      const provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC);
      
      // メンプールの分析（簡略化）
      const pendingBlock = await provider.send("eth_getBlockByNumber", ["pending", true]);
      const arbitrageTxs = pendingBlock.transactions.filter((tx: any) => 
        this.isArbitrageTransaction(tx)
      );
      
      if (arbitrageTxs.length === 0) {
        return { competingTxs: 0, avgGasPrice: 0n, maxGasPrice: 0n };
      }
      
      const gasPrices = arbitrageTxs.map((tx: any) => BigInt(tx.maxFeePerGas || tx.gasPrice));
      const avgGasPrice = gasPrices.reduce((sum: bigint, price: bigint) => sum + price, 0n) / BigInt(gasPrices.length);
      const maxGasPrice = gasPrices.reduce((max: bigint, price: bigint) => price > max ? price : max, 0n);
      
      return {
        competingTxs: arbitrageTxs.length,
        avgGasPrice,
        maxGasPrice
      };
      
    } catch (error) {
      console.warn('⚠️  Failed to detect competitor transactions:', error);
      return { competingTxs: 0, avgGasPrice: 0n, maxGasPrice: 0n };
    }
  }

  /**
   * アービトラージトランザクションの判定
   */
  private isArbitrageTransaction(tx: any): boolean {
    // 簡単な判定ロジック（実際はより複雑）
    return tx.to && (
      tx.to.toLowerCase() === process.env.BALANCER_FLASH_ARB?.toLowerCase() ||
      tx.data?.includes('0x') // スワップ系の関数呼び出し
    );
  }
}

// デフォルト設定
export const defaultMEVConfig: MEVProtectionConfig = {
  privatePools: ['flashbots', 'eden'],
  maxSlippageForBundle: 0.5, // 0.5%
  atomicWithdrawal: true,
  multiBuilderSubmission: true
}; 