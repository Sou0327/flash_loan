import express = require('express');
import { register, Counter, Gauge, Histogram } from 'prom-client';

const app = express();
const PORT = process.env.METRICS_PORT || 3001;

// アクセス制限設定
const METRICS_AUTH_USER = process.env.METRICS_AUTH_USER || 'admin';
const METRICS_AUTH_PASS = process.env.METRICS_AUTH_PASS || 'changeme';
const ALLOWED_IPS = process.env.METRICS_ALLOWED_IPS?.split(',') || ['127.0.0.1', '::1'];

// Basic認証ミドルウェア
function basicAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const auth = req.headers.authorization;
  
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Metrics"');
    res.status(401).send('Authentication required');
    return;
  }
  
  const credentials = Buffer.from(auth.slice(6), 'base64').toString();
  const [username, password] = credentials.split(':');
  
  if (username !== METRICS_AUTH_USER || password !== METRICS_AUTH_PASS) {
    res.status(401).send('Invalid credentials');
    return;
  }
  
  next();
}

// IP制限ミドルウェア
function ipRestriction(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
  
  if (!ALLOWED_IPS.includes(clientIP || '')) {
    console.warn(`🚫 Metrics access denied from IP: ${clientIP}`);
    res.status(403).send('Access denied');
    return;
  }
  
  next();
}

// メトリクス定義
export const metrics = {
  // カウンター
  totalTransactions: new Counter({
    name: 'arbitrage_transactions_total',
    help: 'Total number of arbitrage transactions attempted',
    labelNames: ['status', 'pair']
  }),
  
  totalProfit: new Counter({
    name: 'arbitrage_profit_usd_total',
    help: 'Total profit in USD',
    labelNames: ['token']
  }),

  failedTransactions: new Counter({
    name: 'arbitrage_failed_transactions_total',
    help: 'Total number of failed arbitrage transactions',
    labelNames: ['reason', 'pair']
  }),
  
  // ゲージ
  currentGasPrice: new Gauge({
    name: 'arbitrage_gas_price_gwei',
    help: 'Current gas price in Gwei'
  }),
  
  ethPrice: new Gauge({
    name: 'arbitrage_eth_price_usd',
    help: 'Current ETH price in USD'
  }),
  
  activeOpportunities: new Gauge({
    name: 'arbitrage_opportunities_active',
    help: 'Number of active arbitrage opportunities'
  }),
  
  avgGasCost: new Gauge({
    name: 'arbitrage_avg_gas_cost_usd',
    help: 'Average gas cost in USD'
  }),

  netProfitPerHour: new Gauge({
    name: 'arbitrage_net_profit_per_hour_usd',
    help: 'Net profit per hour in USD (profit - gas costs)'
  }),

  failedTxPerHour: new Gauge({
    name: 'arbitrage_failed_tx_per_hour',
    help: 'Failed transactions per hour'
  }),

  successRate: new Gauge({
    name: 'arbitrage_success_rate_percent',
    help: 'Success rate percentage over the last hour'
  }),
  
  // ヒストグラム
  profitPercentage: new Histogram({
    name: 'arbitrage_profit_percentage',
    help: 'Profit percentage distribution',
    buckets: [0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0]
  }),
  
  executionTime: new Histogram({
    name: 'arbitrage_execution_duration_seconds',
    help: 'Time taken to execute arbitrage',
    buckets: [1, 5, 10, 30, 60, 120]
  })
};

// 時間当たりメトリクス計算用の状態管理
class HourlyMetricsTracker {
  private hourlyData: Array<{
    timestamp: number;
    profit: number;
    gasCost: number;
    success: boolean;
    reason?: string;
  }> = [];

  addTransaction(profit: number, gasCost: number, success: boolean, reason?: string) {
    const now = Date.now();
    this.hourlyData.push({
      timestamp: now,
      profit,
      gasCost,
      success,
      reason
    });

    // 1時間以上古いデータを削除
    const oneHourAgo = now - 3600000; // 1時間 = 3600000ms
    this.hourlyData = this.hourlyData.filter(data => data.timestamp > oneHourAgo);

    // メトリクスを更新
    this.updateHourlyMetrics();
  }

  private updateHourlyMetrics() {
    if (this.hourlyData.length === 0) {
      metrics.netProfitPerHour.set(0);
      metrics.failedTxPerHour.set(0);
      metrics.successRate.set(0);
      return;
    }

    // 純利益計算（利益 - ガス代）
    const netProfit = this.hourlyData.reduce((sum, data) => {
      return sum + (data.success ? data.profit - data.gasCost : -data.gasCost);
    }, 0);

    // 失敗取引数
    const failedCount = this.hourlyData.filter(data => !data.success).length;

    // 成功率
    const successCount = this.hourlyData.filter(data => data.success).length;
    const successRate = (successCount / this.hourlyData.length) * 100;

    // メトリクス更新
    metrics.netProfitPerHour.set(netProfit);
    metrics.failedTxPerHour.set(failedCount);
    metrics.successRate.set(successRate);

    console.log(`📊 Hourly metrics: Net profit: $${netProfit.toFixed(2)}, Failed: ${failedCount}, Success rate: ${successRate.toFixed(1)}%`);
  }

  getHourlyStats() {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const recentData = this.hourlyData.filter(data => data.timestamp > oneHourAgo);

    return {
      totalTransactions: recentData.length,
      successfulTransactions: recentData.filter(data => data.success).length,
      failedTransactions: recentData.filter(data => !data.success).length,
      totalProfit: recentData.reduce((sum, data) => sum + (data.success ? data.profit : 0), 0),
      totalGasCost: recentData.reduce((sum, data) => sum + data.gasCost, 0),
      netProfit: recentData.reduce((sum, data) => sum + (data.success ? data.profit - data.gasCost : -data.gasCost), 0),
      successRate: recentData.length > 0 ? (recentData.filter(data => data.success).length / recentData.length) * 100 : 0
    };
  }
}

// シングルトンインスタンス
const hourlyTracker = new HourlyMetricsTracker();

// メトリクス更新関数（拡張版）
export function updateMetrics(data: {
  transactionStatus?: 'success' | 'failed';
  pair?: string;
  profitUSD?: number;
  token?: string;
  gasPrice?: number;
  ethPrice?: number;
  activeOpportunities?: number;
  avgGasCost?: number;
  profitPercentage?: number;
  executionTime?: number;
  gasCostUSD?: number;
  failureReason?: string;
}) {
  if (data.transactionStatus && data.pair) {
    metrics.totalTransactions.inc({ status: data.transactionStatus, pair: data.pair });
    
    // 失敗取引の詳細追跡
    if (data.transactionStatus === 'failed' && data.failureReason) {
      metrics.failedTransactions.inc({ reason: data.failureReason, pair: data.pair });
    }
  }
  
  if (data.profitUSD && data.token) {
    metrics.totalProfit.inc({ token: data.token }, data.profitUSD);
  }
  
  if (data.gasPrice) {
    metrics.currentGasPrice.set(data.gasPrice);
  }
  
  if (data.ethPrice) {
    metrics.ethPrice.set(data.ethPrice);
  }
  
  if (data.activeOpportunities !== undefined) {
    metrics.activeOpportunities.set(data.activeOpportunities);
  }
  
  if (data.avgGasCost) {
    metrics.avgGasCost.set(data.avgGasCost);
  }
  
  if (data.profitPercentage) {
    metrics.profitPercentage.observe(data.profitPercentage);
  }
  
  if (data.executionTime) {
    metrics.executionTime.observe(data.executionTime);
  }

  // 時間当たりメトリクス更新
  if (data.transactionStatus && data.profitUSD !== undefined && data.gasCostUSD !== undefined) {
    hourlyTracker.addTransaction(
      data.profitUSD,
      data.gasCostUSD,
      data.transactionStatus === 'success',
      data.failureReason
    );
  }
}

// 時間当たり統計取得
export function getHourlyStats() {
  return hourlyTracker.getHourlyStats();
}

// メトリクスエンドポイント（アクセス制限付き）
app.get('/metrics', ipRestriction, basicAuth, async (req: express.Request, res: express.Response) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error);
  }
});

// ヘルスチェック（認証不要）
app.get('/health', (req: express.Request, res: express.Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// サーバー起動
export function startMetricsServer() {
  app.listen(PORT, () => {
    console.log(`📊 Metrics server running on http://localhost:${PORT}/metrics`);
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('📊 Metrics server shutting down...');
  process.exit(0);
}); 