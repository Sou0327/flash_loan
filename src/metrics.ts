import express = require('express');
import { register, Counter, Gauge, Histogram } from 'prom-client';

const app = express();
const PORT = process.env.METRICS_PORT || 3001;

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

// メトリクス更新関数
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
}) {
  if (data.transactionStatus && data.pair) {
    metrics.totalTransactions.inc({ status: data.transactionStatus, pair: data.pair });
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
}

// メトリクスエンドポイント
app.get('/metrics', async (req: express.Request, res: express.Response) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error);
  }
});

// ヘルスチェック
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