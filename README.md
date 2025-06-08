# Balancer Flash Loan Arbitrage Bot

[English quick start guide](README_EN.md) is available.

## 🛡️ **リスク管理システム搭載版**

包括的なリスク管理機能を搭載したBalancerフラッシュローンアービトラージボットです。

## 🚀 **2025年版 高度戦略対応**

従来の往復アービトラージでは利益が出ない現在の効率的市場に対応した高度戦略を実装：

### 🎯 **実装済み高度戦略**

1. **💰 大型金額アービトラージ**
   - 50K〜250K USDCでの大型取引
   - 小額では見えない機会を検出
   - 価格インパクトを利用

2. **🔺 三角アービトラージ**
   - A→B→C→A の3トークン循環取引
   - USDC→WETH→WBTC→USDC等
   - 高流動性ペアに特化

3. **🔄 代替トークンアービトラージ**
   - LINK、UNI、AAVE等のアルトコイン
   - メジャーペア以外での機会発見
   - ボラティリティを活用

4. **📊 価格インパクト分析**
   - 大型取引での価格変動を予測
   - スリッページを利益に転換
   - 流動性の薄いペアを狙い撃ち

### 🚀 **クイックスタート**

1. **環境変数設定**
```bash
# .envファイルを作成
cp .env.example .env

# 必須項目を設定
PRIVATE_KEY=0x...  # あなたのプライベートキー
MAINNET_RPC=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ZX_API_KEY=your_0x_api_key

# 高度戦略を有効化
USE_ADVANCED_STRATEGIES=true
AGGRESSIVENESS_LEVEL=3  # 1=保守的, 2=バランス, 3=積極的
ADVANCED_STRATEGY_INTERVAL=50  # 50ブロックごとに実行
```

2. **依存関係インストール**
```bash
npm install
```

3. **コンパイル**
```bash
npm run compile
```

4. **高度戦略テスト**
```bash
# 高度戦略の機会検出をテスト
npm run test:advanced
```

5. **実行**
```bash
# リスク管理システム + 高度戦略で実行
npm run start

# または
npm run scan
```

### 🎯 **戦略選択ガイド**

#### **現在の市場状況（2025年）**
- ✅ **ガス価格**: 超低い (0.8 Gwei)
- ❌ **往復損失**: 2-3% (従来手法では不可能)
- ✅ **高度戦略**: 有効

#### **推奨設定**

**保守的運用 (AGGRESSIVENESS_LEVEL=1)**
```bash
USE_ADVANCED_STRATEGIES=true
ADVANCED_STRATEGY_INTERVAL=100  # 100ブロックごと
MAX_DAILY_LOSS_USD=500
```

**積極的運用 (AGGRESSIVENESS_LEVEL=3)**
```bash
USE_ADVANCED_STRATEGIES=true
ADVANCED_STRATEGY_INTERVAL=25   # 25ブロックごと
MAX_DAILY_LOSS_USD=2000
```

### 🛡️ **リスク管理機能**

#### **損失制限**
- **日次最大損失**: $1,000
- **時間最大損失**: $200
- **連続失敗制限**: 3回で一時停止
- **損失後クールダウン**: 5分間

#### **リスク評価項目**
1. ✅ **成功率監視** - 過去1時間の成功率30%以上
2. ✅ **流動性チェック** - 最小$100k流動性要件
3. ✅ **ガス価格制限** - 設定上限以下でのみ実行
4. ✅ **利益マージン** - ガス代の3倍以上の利益確保
5. ✅ **借入額制限** - $50k超の大口取引警告
6. ✅ **価格インパクト** - スリッページ2%以下

#### **アラート機能**
- 🚨 **重要な警告** - コンソール + Slack通知
- 📊 **大口機会** - $200超の利益機会を通知
- ⚠️ **リスク警告** - 実行ブロック理由を表示

### ⚙️ **設定オプション**

#### **積極性レベル**
```bash
# 環境変数で調整
AGGRESSIVENESS_LEVEL=1  # 保守的（3パス、15ブロック間隔）
AGGRESSIVENESS_LEVEL=2  # バランス（6パス、8ブロック間隔）
AGGRESSIVENESS_LEVEL=3  # 積極的（8パス、6ブロック間隔）
```

#### **高度戦略設定**
```bash
USE_ADVANCED_STRATEGIES=true           # 高度戦略を有効化
ADVANCED_STRATEGY_INTERVAL=50          # 実行間隔（ブロック数）
LARGE_AMOUNT_MIN_USD=50000            # 大型金額の最小値
TRIANGULAR_MIN_PROFIT_BPS=10          # 三角アービトラージ最小利益率
```

#### **自動引き出し**
```bash
AUTO_WITHDRAW_ENABLED=true
AUTO_WITHDRAW_THRESHOLD=1000  # $1000で自動引き出し
AUTO_WITHDRAW_TOKEN=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  # USDC
```

#### **Slack通知**
```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK
```

### 📊 **メトリクス監視**

```bash
# メトリクスサーバー起動
METRICS_ENABLED=true npm run start

# Prometheusメトリクス確認
curl http://localhost:3001/metrics
```

**利用可能メトリクス:**
- `arbitrage_transactions_total` - 総取引数
- `arbitrage_profit_usd_total` - 総利益（USD）
- `arbitrage_success_rate_percent` - 成功率
- `arbitrage_net_profit_per_hour_usd` - 時間当たり純利益
- `arbitrage_failed_tx_per_hour` - 時間当たり失敗数

### 🧪 **テスト実行**

```bash
# 高度戦略テスト
npm run test:advanced

# フォーク環境でテスト
npm run test:fork

# 基本テスト
npm run test

# セキュリティテスト
npm run security:audit

# ファズテスト
npm run test:fuzz
```

### 🔒 **セキュリティ機能**

- ✅ **Re-entrancy保護** - 完全なガード実装
- ✅ **信頼できるスワップターゲット** - ホワイトリスト制御
- ✅ **MEV保護** - Flashbots対応（オプション）
- ✅ **価格フィード検証** - Chainlink + フォールバック
- ✅ **ガス制限** - 動的上限設定

### 📈 **パフォーマンス最適化**

- ⚡ **API負荷軽減** - Rate limit対応
- ⚡ **キャッシュシステム** - Redis + メモリキャッシュ
- ⚡ **並列処理制限** - API乱用防止
- ⚡ **ガス最適化** - 実績ベース見積もり

### 🚨 **重要な注意事項**

1. **プライベートキー管理**
   - 絶対に公開しないでください
   - 本番環境では環境変数として設定

2. **資金管理**
   - 小額から開始してください
   - リスク制限を適切に設定

3. **API制限**
   - 0x API キーの取得が必要
   - Rate limit内での使用を心がけ

4. **ネットワーク設定**
   - 安定したRPCプロバイダーを使用
   - WebSocket接続の監視

5. **市場効率性**
   - 2025年現在、従来手法では利益困難
   - 高度戦略の使用を強く推奨

### 📞 **サポート**

問題が発生した場合：

1. **ログ確認** - コンソール出力をチェック
2. **環境変数** - 設定値を再確認
3. **ネットワーク** - RPC接続状態を確認
4. **残高確認** - ETH残高が十分か確認

### 🔄 **アップデート履歴**

- **v0.3.0** - 高度アービトラージ戦略実装
- **v0.2.0** - リスク管理システム実装
- **v0.1.0** - 基本アービトラージ機能

---

**⚠️ 免責事項**: このソフトウェアは教育目的で提供されています。実際の取引での損失について、開発者は一切の責任を負いません。自己責任でご利用ください。