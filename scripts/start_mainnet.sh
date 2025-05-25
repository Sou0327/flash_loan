#!/bin/bash

echo "🚀 Starting Balancer Flash Loan Arbitrage Bot on MAINNET"
echo "⚠️  WARNING: This will execute real transactions with real money!"
echo ""

# 設定確認
echo "📊 Configuration Check:"
echo "   - Contract: $BALANCER_FLASH_ARB"
echo "   - Network: MAINNET"
echo "   - Private Key: ${PRIVATE_KEY:0:10}..."
echo ""

# 確認プロンプト
read -p "Are you sure you want to start the bot on MAINNET? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "❌ Cancelled by user"
    exit 1
fi

echo ""
echo "🔴 STARTING LIVE TRADING BOT..."
echo "📊 Press Ctrl+C to stop"
echo ""

# 本番環境でスキャナーを実行
npx ts-node src/balancer_scanner.ts 