# Balancer Flash Loan Arbitrage Bot - 運用ガイド

## 🚨 緊急時対応

### 緊急停止手順
```bash
# 1. 緊急停止の実行
npx hardhat run scripts/emergency_pause.ts --network mainnet

# 2. 停止確認
npx hardhat run scripts/check_status.ts --network mainnet
```

### 緊急停止解除
```bash
# 問題解決後の再開
npx hardhat run scripts/emergency_unpause.ts --network mainnet
```

## 🔧 設定管理

### 環境変数設定
```bash
# 必須設定
PRIVATE_KEY=0x...                    # ウォレット秘密鍵
MAINNET_RPC=https://...              # Ethereum RPC URL
ZX_API_KEY=...                       # 0x Protocol APIキー

# MEV保護設定
USE_FLASHBOTS=true                   # Flashbots使用フラグ
FLASHBOTS_RPC=https://rpc.flashbots.net

# 自動引き出し設定
AUTO_WITHDRAW_ENABLED=true           # 自動引き出し有効化
AUTO_WITHDRAW_THRESHOLD=1000         # 引き出し閾値（USD）
AUTO_WITHDRAW_TOKEN=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  # USDC

# メトリクス設定
METRICS_ENABLED=true                 # Prometheusメトリクス
METRICS_PORT=3001                    # メトリクスポート
```

### API キー更新手順

#### 0x Protocol API
1. [0x Dashboard](https://dashboard.0x.org/)にログイン
2. 新しいAPIキーを生成
3. `.env`ファイルの`ZX_API_KEY`を更新
4. ボット再起動

#### 1inch API
1. [1inch Developer Portal](https://portal.1inch.dev/)にログイン
2. 新しいAPIキーを生成
3. `.env`ファイルの`ONEINCH_API_KEY`を更新
4. ボット再起動

## 🔄 MEV保護設定

### Flashbots RPC切り替え
```bash
# Flashbots有効化
export USE_FLASHBOTS=true
export FLASHBOTS_RPC=https://rpc.flashbots.net

# 通常RPC（フォールバック）
export USE_FLASHBOTS=false
```

### MEV-Share設定
```bash
# MEV-Share使用（高度な設定）
export FLASHBOTS_RPC=https://rpc.mev-share.flashbots.net
```

## 📊 監視・メトリクス

### Prometheusメトリクス
- URL: `http://localhost:3001/metrics`
- 主要メトリクス:
  - `arbitrage_transactions_total`: 総取引数
  - `arbitrage_profit_usd_total`: 総利益（USD）
  - `arbitrage_gas_price_gwei`: 現在のガス価格
  - `arbitrage_opportunities_active`: アクティブな機会数

### ログ監視
```bash
# リアルタイムログ
tail -f logs/arbitrage.log

# エラーログのみ
grep "❌\|ERROR" logs/arbitrage.log
```

## 🔧 トラブルシューティング

### よくある問題と解決策

#### 1. ガス価格高騰時
```bash
# ガス係数を調整
# CONFIG.PROFIT.GAS_MULTIPLIER を 2.0 → 3.0 に変更
```

#### 2. API Rate Limit
```bash
# プロバイダー切り替え確認
grep "Rate limited" logs/arbitrage.log

# APIキー確認
curl -H "0x-api-key: $ZX_API_KEY" https://api.0x.org/swap/v1/price?sellToken=WETH&buyToken=USDC&sellAmount=1000000000000000000
```

#### 3. 利益機会が見つからない
```bash
# 最小利益率を確認
grep "below.*%" logs/arbitrage.log | tail -10

# 市場状況確認
curl "https://api.0x.org/swap/v1/price?sellToken=WETH&buyToken=USDC&sellAmount=1000000000000000000"
```

#### 4. トランザクション失敗
```bash
# revert理由確認
grep "InsufficientProfit\|SwapFailed" logs/arbitrage.log

# ガス見積もり確認
grep "Gas used:" logs/arbitrage.log | tail -5
```

## 🚀 デプロイ・更新手順

### 新バージョンデプロイ
```bash
# 1. 現在のボットを緊急停止
npx hardhat run scripts/emergency_pause.ts --network mainnet

# 2. 新しいコントラクトをデプロイ
npx hardhat run scripts/deploy.ts --network mainnet

# 3. 設定ファイル更新
# BALANCER_FLASH_ARB=新しいアドレス

# 4. テスト実行
npm run test:integration

# 5. 本番開始
npm run scan
```

### 設定変更のみ
```bash
# 1. ボット停止（Ctrl+C）
# 2. .env ファイル編集
# 3. ボット再起動
npm run scan
```

## 📈 パフォーマンス最適化

### 利益率調整
```typescript
// src/balancer_scanner.ts
CONFIG.PROFIT.GAS_MULTIPLIER = 2.5;  // ガス高騰時
CONFIG.PROFIT.MIN_PERCENTAGE = 0.3;  // 最小利益率上げ
```

### ガス最適化
```typescript
// より保守的な設定
CONFIG.GAS.MAX_PRICE_GWEI = 20;      // ガス上限下げ
CONFIG.GAS.PRIORITY_FEE_GWEI = 1.0;  // 優先料金下げ
```

## 🔐 セキュリティ

### ウォレット管理
- 秘密鍵は環境変数で管理
- 定期的なキーローテーション
- マルチシグ検討（高額運用時）

### アクセス制御
- サーバーアクセス制限
- APIキーの定期更新
- ログの機密情報マスキング

## 📞 緊急連絡先

### 技術サポート
- GitHub Issues: [リポジトリURL]/issues
- Discord: [サーバー招待リンク]
- Email: support@example.com

### 外部サービス
- 0x Protocol: support@0x.org
- 1inch: support@1inch.io
- Flashbots: support@flashbots.net

---

## 📋 チェックリスト

### 日次確認
- [ ] ボット稼働状況
- [ ] 利益・損失確認
- [ ] ガス使用量確認
- [ ] エラーログ確認

### 週次確認
- [ ] APIキー使用量
- [ ] パフォーマンス統計
- [ ] 設定最適化検討

### 月次確認
- [ ] セキュリティ監査
- [ ] 依存関係更新
- [ ] バックアップ確認