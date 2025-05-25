#!/bin/bash

echo "🧪 Starting Fork Environment Test"
echo ""

# フォーク環境の起動確認
if ! curl -s http://127.0.0.1:8545 > /dev/null; then
    echo "🚀 Starting Hardhat fork environment..."
    npx hardhat node --fork https://eth-mainnet.g.alchemy.com/v2/zzByA-cF5rYkV0BfO34ZteM-37zGfx6s --port 8545 &
    HARDHAT_PID=$!
    
    echo "⏳ Waiting for fork environment to start..."
    sleep 10
else
    echo "✅ Fork environment already running"
fi

echo ""
echo "🧪 Deploying contract to fork environment..."
CONTRACT_ADDRESS=$(npx hardhat run scripts/deploy_fork_test.ts --network localhost | grep "Contract deployed at:" | awk '{print $4}')

if [ -z "$CONTRACT_ADDRESS" ]; then
    echo "❌ Failed to get contract address"
    exit 1
fi

echo "✅ Contract deployed at: $CONTRACT_ADDRESS"

echo ""
echo "🔍 Running fork test..."
FORK_CONTRACT_ADDRESS=$CONTRACT_ADDRESS npx ts-node src/test_fork.ts

echo ""
echo "🧪 Starting scanner in fork environment..."
echo "📊 Press Ctrl+C to stop"
echo ""

# フォーク環境でスキャナーを実行
FORK_TEST=true MAINNET_RPC=http://127.0.0.1:8545 BALANCER_FLASH_ARB=$CONTRACT_ADDRESS npx ts-node src/balancer_scanner.ts 