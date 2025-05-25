# Flash Loan Arbitrage Bot

Balancerのフラッシュローンを使用したアービトラージボットです。0x Protocol APIを使用して最適なスワップルートを見つけます。

## 特徴

- **Balancerフラッシュローン**: 手数料無料でトークンを借用
- **0x Protocol統合**: 130+のDEXから最適価格を取得
- **自動アービトラージ**: 利益機会を自動検出・実行
- **ガス効率**: 最適化されたスマートコントラクト
- **リアルタイム監視**: WebSocket接続でリアルタイム価格監視

## 必要な環境変数

`.env`ファイルを作成して以下の変数を設定してください：

```bash
# Ethereum Network
ALCHEMY_WSS=wss://eth-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
PRIVATE_KEY=YOUR_PRIVATE_KEY

# Contract Addresses
BALANCER_FLASH_ARB=YOUR_DEPLOYED_CONTRACT_ADDRESS

# Token Addresses (Mainnet)
USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
DAI=0x6B175474E89094C44Da98b954EedeAC495271d0F

# 0x Protocol API Key (無料取得: https://dashboard.0x.org/create-account)
ZX_API_KEY=YOUR_0X_API_KEY
```

## 0x Protocol APIキーの取得

1. [0x Dashboard](https://dashboard.0x.org/create-account)にアクセス
2. アカウントを作成
3. 無料のAPIキーを取得
4. `.env`ファイルに`ZX_API_KEY`として設定

## インストール

```bash
npm install
```

## 使用方法

### 1. シミュレーション実行

```bash
npx hardhat run scripts/simulate_balancer.ts --network mainnet
```

### 2. リアルタイム監視開始

```bash
npx ts-node src/balancer_scanner.ts
```

## 0x Protocol APIの利点

- **無料**: 基本的な使用は無料
- **高い流動性**: 130+のDEXから最適価格
- **低いリバート率**: 業界最低の5%
- **Permit2サポート**: セキュリティ向上
- **優れたドキュメント**: 詳細なAPI仕様

## アーキテクチャ

1. **価格監視**: 0x Protocol APIで複数DEXの価格を監視
2. **機会検出**: アービトラージ機会を自動検出
3. **フラッシュローン実行**: Balancerから無料でトークンを借用
4. **スワップ実行**: 0x Protocolで最適ルートでスワップ
5. **利益確定**: 借用額を返済し、利益を確保

## 注意事項

- **テストネットでテスト**: 本番前に必ずテストネットで動作確認
- **ガス価格監視**: 高いガス価格時は実行を控える
- **スリッページ設定**: 適切なスリッページ許容値を設定
- **リスク管理**: 損失の可能性を理解して使用

## ライセンス

MIT License