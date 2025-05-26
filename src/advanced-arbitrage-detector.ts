import { ethers } from "ethers";

// 型定義
interface ArbitrageOpportunity {
  type: 'triangular' | 'cross_dex' | 'liquidation' | 'mev' | 'oracle_delay' | 'large_amount';
  profitPercent: number;
  estimatedProfit: number;
  path?: string;
  pair?: string;
  confidence: number; // 0-1の信頼度
  gasEstimate?: number;
  timeWindow?: number; // 機会の有効時間（秒）
  [key: string]: any;
}

interface Token {
  symbol: string;
  address: string;
  decimals: number;
}

// 📊 リアルタイム機会検出システム
export class AdvancedArbitrageDetector {
  private provider: ethers.JsonRpcProvider;
  private opportunities: Map<string, ArbitrageOpportunity> = new Map();
  private apiKey: string;

  // 主要トークン定義
  private readonly TOKENS: Token[] = [
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'LINK', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
    { symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
    { symbol: 'AAVE', address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18 }
  ];

  constructor(provider: ethers.JsonRpcProvider, apiKey: string) {
    this.provider = provider;
    this.apiKey = apiKey;
  }

  /**
   * 🎯 戦略1: 大型金額でのアービトラージテスト
   * 小額では見えない機会を大型金額で検出
   */
  async detectLargeAmountArbitrage(): Promise<ArbitrageOpportunity[]> {
    console.log("💰 大型金額アービトラージ検出中...");
    
    const opportunities: ArbitrageOpportunity[] = [];
    
    // 🔧 修正: より現実的な金額設定
    const testAmountConfigs = [
      { usdValue: 5000, label: "5K USD" },     // $5,000 (実行可能)
      { usdValue: 10000, label: "10K USD" },   // $10,000 (実行可能)  
      { usdValue: 25000, label: "25K USD" },   // $25,000 (実行可能)
    ];

    const pairs = [
      { from: 'USDC', to: 'WETH', name: 'USDC->WETH->USDC' },
      { from: 'USDC', to: 'WBTC', name: 'USDC->WBTC->USDC' },
      { from: 'USDC', to: 'DAI', name: 'USDC->DAI->USDC' },
      { from: 'WETH', to: 'USDT', name: 'WETH->USDT->WETH' },
    ];

    for (const config of testAmountConfigs) {
      for (const pair of pairs) {
        try {
          const fromToken = this.TOKENS.find(t => t.symbol === pair.from)!;
          const toToken = this.TOKENS.find(t => t.symbol === pair.to)!;
          
          if (!fromToken || !toToken) continue;

          // トークン価格を取得
          const tokenPriceUSD = await this.getTokenPriceUSD(fromToken.address);
          if (!tokenPriceUSD) continue;

          // USD価値に基づいて正確な金額を計算
          const testAmountTokens = config.usdValue / tokenPriceUSD;
          const testAmountWei = (testAmountTokens * Math.pow(10, fromToken.decimals)).toString();

          console.log(`💰 検証中: ${pair.name} (${config.label})`);
          console.log(`   価格: $${tokenPriceUSD.toFixed(2)} | 数量: ${testAmountTokens.toFixed(4)} ${fromToken.symbol}`);

          const opportunity = await this.testRoundTripArbitrage(
            fromToken,
            toToken,
            testAmountWei,
            `${config.label} ${pair.name}`
          );

          if (opportunity && opportunity.profitPercent > 0.1) { // 🔧 0.5%から0.1%に下げて検出感度向上
            console.log(`🎯 大型機会発見: ${pair.name} with ${config.label} (+${opportunity.profitPercent.toFixed(4)}%)`);
            opportunities.push(opportunity);
          }

          // API制限対策: より長い待機時間
          await new Promise(resolve => setTimeout(resolve, 800));

        } catch (error) {
          console.warn(`⚠️ 大型金額検証失敗 (${config.label} ${pair.name}):`, error instanceof Error ? error.message : String(error));
          await new Promise(resolve => setTimeout(resolve, 400));
        }
      }
    }

    console.log(`💰 大型金額機会: ${opportunities.length}件`);
    return opportunities;
  }

  /**
   * 🎯 戦略2: 三角アービトラージ
   * A->B->C->A の3つのトークンを使った循環取引
   */
  async detectTriangularArbitrage(): Promise<ArbitrageOpportunity[]> {
    console.log("🔺 三角アービトラージ検出中...");
    
    const opportunities: ArbitrageOpportunity[] = [];
    const testAmount = "10000000000"; // 10,000 USDC

    // 効率的な三角パスのみテスト（高流動性組み合わせ）
    const efficientPaths = [
      ['USDC', 'WETH', 'WBTC'],
      ['USDC', 'WETH', 'DAI'],
      ['USDC', 'WBTC', 'WETH'],
      ['WETH', 'USDC', 'DAI'],
      ['WETH', 'USDT', 'USDC'],
      ['USDC', 'LINK', 'WETH'],
      ['USDC', 'UNI', 'WETH'],
    ];

    for (const path of efficientPaths) {
      try {
        const tokenA = this.TOKENS.find(t => t.symbol === path[0])!;
        const tokenB = this.TOKENS.find(t => t.symbol === path[1])!;
        const tokenC = this.TOKENS.find(t => t.symbol === path[2])!;
        
        const opportunity = await this.testTriangularPath(
          tokenA, tokenB, tokenC, testAmount
        );
        
        if (opportunity && opportunity.profitPercent > 0.1) { // 0.1%以上
          opportunities.push(opportunity);
          console.log(`🎯 三角機会発見: ${path.join('->')} (+${opportunity.profitPercent.toFixed(4)}%)`);
        }
        
        // API制限対策
        await new Promise(resolve => setTimeout(resolve, 600));
        
      } catch (error) {
        console.warn(`⚠️ 三角パステスト失敗: ${path.join('->')}`);
      }
    }

    return opportunities;
  }

  /**
   * 🎯 戦略3: 代替トークンアービトラージ
   * メジャートークン以外での機会検出
   */
  async detectAlternativeTokenArbitrage(): Promise<ArbitrageOpportunity[]> {
    console.log("🔄 代替トークンアービトラージ検出中...");
    
    const opportunities: ArbitrageOpportunity[] = [];
    const testAmount = "10000000000"; // 10,000 USDC

    const altPairs = [
      { from: 'USDC', via: 'LINK', name: 'USDC->LINK->USDC' },
      { from: 'USDC', via: 'UNI', name: 'USDC->UNI->USDC' },
      { from: 'USDC', via: 'AAVE', name: 'USDC->AAVE->USDC' },
      { from: 'WETH', via: 'LINK', name: 'WETH->LINK->WETH' },
      { from: 'WETH', via: 'UNI', name: 'WETH->UNI->WETH' },
    ];

    for (const pair of altPairs) {
      try {
        const fromToken = this.TOKENS.find(t => t.symbol === pair.from)!;
        const viaToken = this.TOKENS.find(t => t.symbol === pair.via)!;
        
        // 適切な金額に調整
        const adjustedAmount = pair.from === 'WETH' ? 
          ethers.parseUnits("3", 18).toString() : // 3 WETH
          testAmount; // 10,000 USDC
        
        const opportunity = await this.testRoundTripArbitrage(
          fromToken, 
          viaToken, 
          adjustedAmount,
          `Alt-${pair.name}`
        );
        
        if (opportunity && opportunity.profitPercent > 0.08) { // 0.08%以上
          opportunities.push(opportunity);
          console.log(`🎯 代替トークン機会: ${pair.name} (+${opportunity.profitPercent.toFixed(4)}%)`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 700));
        
      } catch (error) {
        console.warn(`⚠️ 代替トークンテスト失敗: ${pair.name}`);
      }
    }

    return opportunities;
  }

  /**
   * 🎯 戦略4: 価格インパクト分析
   * 大型取引での価格インパクトを利用
   */
  async detectPriceImpactOpportunities(): Promise<ArbitrageOpportunity[]> {
    console.log("📊 価格インパクト機会検出中...");
    
    const opportunities: ArbitrageOpportunity[] = [];
    
    const impactTests = [
      { token: 'USDC', amounts: ['100000000000', '500000000000', '1000000000000'] }, // 100K, 500K, 1M
      { token: 'WETH', amounts: ['50000000000000000000', '100000000000000000000'] }, // 50, 100 WETH
    ];

    for (const test of impactTests) {
      const token = this.TOKENS.find(t => t.symbol === test.token)!;
      const targetToken = test.token === 'USDC' ? 
        this.TOKENS.find(t => t.symbol === 'WETH')! :
        this.TOKENS.find(t => t.symbol === 'USDC')!;

      for (let i = 0; i < test.amounts.length - 1; i++) {
        try {
          const smallAmount = test.amounts[i];
          const largeAmount = test.amounts[i + 1];
          
          const smallPrice = await this.getPrice(token.address, targetToken.address, smallAmount);
          await new Promise(resolve => setTimeout(resolve, 500));
          const largePrice = await this.getPrice(token.address, targetToken.address, largeAmount);
          
          if (smallPrice && largePrice) {
            const smallRate = Number(smallPrice) / Number(smallAmount);
            const largeRate = Number(largePrice) / Number(largeAmount);
            const priceImpact = Math.abs(largeRate - smallRate) / smallRate;
            
            if (priceImpact > 0.005) { // 0.5%以上の価格インパクト
              opportunities.push({
                type: 'large_amount',
                pair: `${token.symbol}->${targetToken.symbol}`,
                profitPercent: priceImpact * 100 * 0.6, // 価格インパクトの60%を利益と仮定
                estimatedProfit: Number(largeAmount) * priceImpact * 0.6,
                confidence: 0.7,
                priceImpact: priceImpact * 100,
                smallAmount,
                largeAmount
              });
              
              console.log(`🎯 価格インパクト機会: ${token.symbol} (${(priceImpact * 100).toFixed(4)}% impact)`);
            }
          }
          
          await new Promise(resolve => setTimeout(resolve, 800));
          
        } catch (error) {
          console.warn(`⚠️ 価格インパクト分析失敗: ${test.token}`);
        }
      }
    }

    return opportunities;
  }

  /**
   * 🎯 統合検出関数
   */
  async detectAllOpportunities(): Promise<{
    largeAmount: ArbitrageOpportunity[];
    triangular: ArbitrageOpportunity[];
    alternative: ArbitrageOpportunity[];
    priceImpact: ArbitrageOpportunity[];
    totalOpportunities: number;
    bestOpportunity?: ArbitrageOpportunity;
  }> {
    console.log("🚀 全戦略統合検出開始...\n");
    
    const results = {
      largeAmount: [] as ArbitrageOpportunity[],
      triangular: [] as ArbitrageOpportunity[],
      alternative: [] as ArbitrageOpportunity[],
      priceImpact: [] as ArbitrageOpportunity[],
      totalOpportunities: 0,
      bestOpportunity: undefined as ArbitrageOpportunity | undefined
    };

    try {
      // 1. 大型金額アービトラージ
      results.largeAmount = await this.detectLargeAmountArbitrage();
      console.log(`💰 大型金額機会: ${results.largeAmount.length}件\n`);
      
      // 2. 三角アービトラージ
      results.triangular = await this.detectTriangularArbitrage();
      console.log(`🔺 三角アービトラージ機会: ${results.triangular.length}件\n`);
      
      // 3. 代替トークンアービトラージ
      results.alternative = await this.detectAlternativeTokenArbitrage();
      console.log(`🔄 代替トークン機会: ${results.alternative.length}件\n`);
      
      // 4. 価格インパクト機会
      results.priceImpact = await this.detectPriceImpactOpportunities();
      console.log(`📊 価格インパクト機会: ${results.priceImpact.length}件\n`);
      
      // 全機会を統合
      const allOpportunities = [
        ...results.largeAmount,
        ...results.triangular,
        ...results.alternative,
        ...results.priceImpact
      ];
      
      results.totalOpportunities = allOpportunities.length;
      
      // 最良の機会を選択
      if (allOpportunities.length > 0) {
        results.bestOpportunity = allOpportunities.reduce((best, current) => 
          current.profitPercent > best.profitPercent ? current : best
        );
      }
      
    } catch (error) {
      console.error("❌ 統合検出エラー:", error);
    }

    return results;
  }

  // =============================
  // ヘルパー関数群
  // =============================

  private async testRoundTripArbitrage(
    fromToken: Token, 
    toToken: Token, 
    amount: string,
    label: string
  ): Promise<ArbitrageOpportunity | null> {
    try {
      // Step 1: from -> to
      const step1 = await this.getPrice(fromToken.address, toToken.address, amount);
      if (!step1) return null;
      
      await new Promise(resolve => setTimeout(resolve, 400));
      
      // Step 2: to -> from
      const step2 = await this.getPrice(toToken.address, fromToken.address, step1);
      if (!step2) return null;
      
      const initialAmount = Number(amount);
      const finalAmount = Number(step2);
      const profit = finalAmount - initialAmount;
      const profitPercent = (profit / initialAmount) * 100;
      
      if (profitPercent > 0) {
        // 🔧 修正: 正しい利益計算
        const tokenPriceUSD = await this.getTokenPriceUSD(fromToken.address);
        
        // 実際の投資額（USD）を計算
        const initialInvestmentTokens = initialAmount / Math.pow(10, fromToken.decimals);
        const initialInvestmentUSD = initialInvestmentTokens * tokenPriceUSD;
        
        // 利益額（USD）を投資額に基づいて計算
        const estimatedProfitUSD = initialInvestmentUSD * (profitPercent / 100);
        
        // 🔧 デバッグログの簡素化
        console.log(`🔧 利益計算:`);
        console.log(`   投資額: ${initialInvestmentTokens.toFixed(4)} ${fromToken.symbol} = $${initialInvestmentUSD.toFixed(2)}`);
        console.log(`   利益率: ${profitPercent.toFixed(4)}%`);
        console.log(`   予想利益: $${estimatedProfitUSD.toFixed(2)}`);
        
        return {
          type: 'large_amount',
          path: `${fromToken.symbol}->${toToken.symbol}->${fromToken.symbol}`,
          profitPercent,
          estimatedProfit: estimatedProfitUSD, // 🔧 修正: 正しいUSD金額
          confidence: 0.8,
          initialAmount,
          finalAmount,
          label
        };
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  private async testTriangularPath(
    tokenA: Token, 
    tokenB: Token, 
    tokenC: Token, 
    amount: string
  ): Promise<ArbitrageOpportunity | null> {
    try {
      // A->B
      const step1 = await this.getPrice(tokenA.address, tokenB.address, amount);
      if (!step1) return null;
      
      await new Promise(resolve => setTimeout(resolve, 400));
      
      // B->C  
      const step2 = await this.getPrice(tokenB.address, tokenC.address, step1);
      if (!step2) return null;
      
      await new Promise(resolve => setTimeout(resolve, 400));
      
      // C->A
      const step3 = await this.getPrice(tokenC.address, tokenA.address, step2);
      if (!step3) return null;
      
      const initialAmount = Number(amount);
      const finalAmount = Number(step3);
      const profit = finalAmount - initialAmount;
      const profitPercent = (profit / initialAmount) * 100;
      
      if (profitPercent > 0) {
        // 🔧 修正: 三角アービトラージも同様に修正
        const tokenPriceUSD = await this.getTokenPriceUSD(tokenA.address);
        
        // 実際の投資額（USD）を計算
        const initialInvestmentTokens = initialAmount / Math.pow(10, tokenA.decimals);
        const initialInvestmentUSD = initialInvestmentTokens * tokenPriceUSD;
        
        // 利益額（USD）を投資額に基づいて計算
        const estimatedProfitUSD = initialInvestmentUSD * (profitPercent / 100);
        
        return {
          type: 'triangular',
          path: `${tokenA.symbol}->${tokenB.symbol}->${tokenC.symbol}->${tokenA.symbol}`,
          profitPercent,
          estimatedProfit: estimatedProfitUSD, // 🔧 修正: 正しいUSD金額
          confidence: 0.75,
          initialAmount,
          finalAmount,
          gasEstimate: 500000, // 三角取引は高ガス
          timeWindow: 30 // 30秒の有効期間
        };
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  private async getPrice(tokenIn: string, tokenOut: string, amount: string): Promise<string | null> {
    try {
      const response = await fetch(
        `https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${tokenIn}&buyToken=${tokenOut}&sellAmount=${amount}`,
        {
          headers: {
            '0x-api-key': this.apiKey,
            '0x-version': 'v2'
          }
        }
      );
      
      if (response.ok) {
        const data = await response.json() as any;
        return data.buyAmount;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  // 🔧 新規追加: トークン価格をUSDで取得
  private async getTokenPriceUSD(tokenAddress: string): Promise<number> {
    try {
      const response = await fetch(
        `https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${tokenAddress}&buyToken=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&sellAmount=1000000000000000000`,
        {
          headers: {
            '0x-api-key': this.apiKey,
            '0x-version': 'v2'
          }
        }
      );

      if (response.ok) {
        const data = await response.json() as any;
        const usdcAmount = Number(data.buyAmount) / 1e6; // USDC has 6 decimals
        return usdcAmount;
      }
      
      // フォールバック価格
      const fallbackPrices: { [key: string]: number } = {
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 1.0, // USDC
        '0x6B175474E89094C44Da98b954EedeAC495271d0F': 1.0, // DAI
        '0xdAC17F958D2ee523a2206206994597C13D831ec7': 1.0, // USDT
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': 3000, // WETH
        '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': 60000, // WBTC
      };
      
      return fallbackPrices[tokenAddress.toLowerCase()] || 1.0;
      
    } catch (error) {
      console.warn(`⚠️ Failed to get USD price for ${tokenAddress}:`, error);
      return 1.0; // フォールバック
    }
  }
}

// 使用例関数
export async function runAdvancedArbitrageDetection(
  provider: ethers.JsonRpcProvider,
  apiKey: string
): Promise<any> {
  const detector = new AdvancedArbitrageDetector(provider, apiKey);
  
  console.log("🚀 高度なアービトラージ戦略実行中...\n");
  
  const results = await detector.detectAllOpportunities();
  
  console.log("📊 === 検出結果サマリー ===");
  console.log(`💰 大型金額機会: ${results.largeAmount.length}件`);
  console.log(`🔺 三角アービトラージ: ${results.triangular.length}件`);
  console.log(`🔄 代替トークン: ${results.alternative.length}件`);
  console.log(`📊 価格インパクト: ${results.priceImpact.length}件`);
  console.log(`🎯 総機会数: ${results.totalOpportunities}件`);
  
  if (results.bestOpportunity) {
    console.log(`\n🏆 最良機会: ${results.bestOpportunity.path || results.bestOpportunity.pair}`);
    console.log(`💰 利益率: ${results.bestOpportunity.profitPercent.toFixed(4)}%`);
    console.log(`🎯 信頼度: ${(results.bestOpportunity.confidence * 100).toFixed(1)}%`);
  }
  
  return results;
} 