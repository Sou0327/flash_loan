# Flash Loan Arbitrage Bot

Balancerのフラッシュローンを使用したアービトラージボットです。0x Protocol APIを使用して最適なスワップルートを見つけます。

## 特徴

- **Balancerフラッシュローン**: 手数料無料でトークンを借用
- **0x Protocol統合**: 130+のDEXから最適価格を取得
- **自動アービトラージ**: 利益機会を自動検出・実行
- **ガス効率**: 最適化されたスマートコントラクト
- **リアルタイム監視**: WebSocket接続でリアルタイム価格監視

## 🚀 セットアップ

### 1. 依存関係のインストール
```bash
npm install
```

### 2. 環境変数の設定
`.env`ファイルを作成：
```bash
# 0x Protocol API
ZX_API_KEY=your_0x_api_key_here

# Ethereum RPC
ALCHEMY_WSS=wss://eth-mainnet.g.alchemy.com/v2/your_key_here

# ウォレット設定
PRIVATE_KEY=0x1234567890abcdef... # 66文字のプライベートキー

# コントラクトアドレス（デプロイ後に設定）
BALANCER_FLASH_ARB=0x...

# テストモード（推奨）
TEST_MODE=true
```

### 3. コントラクトのデプロイ

#### テスト用（フォークネットワーク）
```bash
# フォークネットワーク起動
npx hardhat node --fork https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# 別ターミナルでデプロイ
npx hardhat run scripts/deploy_balancer.ts --network localhost
```

#### 本格運用（メインネット）
```bash
# メインネットにデプロイ（要注意！）
npx hardhat run scripts/deploy_balancer.ts --network mainnet
```

**⚠️ メインネットデプロイの注意点:**
- **ガス代**: 約0.01-0.02 ETH必要
- **不可逆**: 一度デプロイすると削除不可
- **セキュリティ**: プライベートキーの管理に注意

## 🧪 テスト手順

### 1. 少額テスト（強く推奨）
```bash
# テストモードを有効化
echo "TEST_MODE=true" >> .env

# スキャナー実行
npm run scanner
```

### 2. 本格運用
```bash
# テストモードを無効化
sed -i '' '/TEST_MODE/d' .env

# スキャナー実行
npm run scanner
```

## 💰 必要資金

### ウォレット残高
- **テスト**: 0.01 ETH（ガス代のみ）
- **本格運用**: 0.1-0.2 ETH（複数回実行分）

### フラッシュローン
- **借入額**: 自動で設定（USDC/DAI）
- **担保**: 不要（瞬時に返済）
- **手数料**: Balancerは無料

## 📊 監視内容

- **USDC → WETH → USDC**
- **DAI → WETH → DAI**
- **最小利益率**: テスト0.1% / 本格0.3%
- **チェック頻度**: 5ブロックごと

## ⚠️ リスク

1. **ガス代**: 失敗時も消費される
2. **MEV競争**: 他のボットとの競合
3. **スリッページ**: 価格変動リスク
4. **スマートコントラクト**: バグのリスク

## 🔧 トラブルシューティング

### よくあるエラー
- `insufficient funds`: ETH残高不足
- `could not decode result`: コントラクト未デプロイ
- `invalid private key`: プライベートキー形式エラー

## ライセンス

MIT License