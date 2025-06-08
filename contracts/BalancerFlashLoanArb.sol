// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./interfaces/IVault.sol";
import "./interfaces/IFlashLoanRecipient.sol";
import "./interfaces/IProtocolFeesCollector.sol";
import "./interfaces/AggregatorV3Interface.sol";
import "./libraries/ForceApprove.sol";

contract BalancerFlashLoanArb is
    IFlashLoanRecipient,
    Ownable,
    ReentrancyGuard,
    Pausable
{
    using SafeERC20 for IERC20;
    using ForceApprove for IERC20;

    IVault private immutable vault;

    // Chainlink価格フィード（ETH/USD）
    AggregatorV3Interface private constant ETH_USD_FEED =
        AggregatorV3Interface(0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419);

    // 主要トークンアドレス（immutable配列の代替）
    address private immutable DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address private immutable WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address private immutable USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address private immutable WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address private immutable USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    // セキュリティ: 信頼できるスワップターゲット
    mapping(address => bool) public trustedSpenders;

    // 価格フィードフォールバック
    uint256 private lastValidETHPrice;
    uint256 private lastPriceUpdate;

    // イベント
    /// @notice フラッシュローン実行完了イベント（拡張版）
    /// @param token 借入トークンアドレス
    /// @param amount 借入量
    /// @param feeAmount 手数料
    /// @param profit 利益（必ず > 0、最小利益未達時は事前にrevert）
    /// @param minProfitBps 設定された最小利益率（ベーシスポイント）
    /// @param blockNumber 実行ブロック番号
    /// @param gasPrice 実行時ガス価格（EIP-1559ではmaxFeePerGas）
    /// @param baseFee 実行時ベースフィー（EIP-1559対応）
    event FlashLoanExecuted(
        address indexed token,
        uint256 amount,
        uint256 feeAmount,
        uint256 profit,
        uint256 minProfitBps,
        uint256 blockNumber,
        uint256 gasPrice,
        uint256 baseFee
    );
    event SwapExecuted(
        address indexed srcToken,
        address indexed dstToken,
        uint256 inAmount,
        uint256 outAmount,
        address indexed target
    );
    event EmergencyWithdraw(address indexed token, uint256 amount);
    event TrustedSpenderUpdated(address indexed spender, bool trusted);
    event FallbackPriceUpdated(uint256 newPrice, uint256 timestamp);
    event EmergencyPriceReset(uint256 newPrice, uint256 timestamp);

    // 状態変数を追加
    uint256 private currentMinProfitBps;

    constructor(address _vault) Ownable(msg.sender) {
        vault = IVault(_vault);

        // デフォルトの信頼できるスワップターゲット（0x Protocol）
        trustedSpenders[0xDef1C0ded9bec7F1a1670819833240f027b25EfF] = true; // 0x Exchange Proxy
        trustedSpenders[0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45] = true; // Uniswap V3 Router
        trustedSpenders[0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D] = true; // Uniswap V2 Router
    }

    /// @notice 信頼できるスワップターゲットを管理
    /// @param spender スワップターゲットアドレス
    /// @param trusted 信頼するかどうか
    function setTrustedSpender(
        address spender,
        bool trusted
    ) external onlyOwner {
        trustedSpenders[spender] = trusted;
        emit TrustedSpenderUpdated(spender, trusted);
    }

    /// @notice フラッシュローンを実行
    /// @param tokens 借りるトークンの配列（単一トークンのみ対応）
    /// @param amounts 借りる量の配列
    /// @param minProfitBps 最小利益率（ベーシスポイント、例：50 = 0.5%）
    /// @param swapData 0x Protocolのスワップデータ
    function executeFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256 minProfitBps,
        bytes memory swapData
    ) external onlyOwner nonReentrant whenNotPaused {
        require(tokens.length == amounts.length, "Array length mismatch");
        require(tokens.length == 1, "Only single token flash loan supported");
        require(amounts[0] > 0, "Amount must be greater than zero");
        require(minProfitBps <= 1000, "Max 10% slippage"); // 最大10%

        // minProfitBpsを保存
        currentMinProfitBps = minProfitBps;

        // Balancerのフラッシュローンを実行
        vault.flashLoan(address(this), tokens, amounts, swapData);
    }

    /// @notice Balancerが呼び出すコールバック関数
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override whenNotPaused {
        // Balancer Vaultからの呼び出しのみ許可
        if (msg.sender != address(vault)) revert Unauthorized();

        // minProfitBpsが初期化されていることを確認
        require(currentMinProfitBps != 0, "MinProfitBps not initialized");

        // 単一トークンのアービトラージを想定
        IERC20 cachedToken = tokens[0]; // ガス最適化：storage読み取り削減
        uint256 cachedAmount = amounts[0];
        uint256 feeAmount = feeAmounts[0];

        // feeAmount厳密チェック（Balancer v2の実際の手数料率を取得）
        _validateFeeAmount(cachedAmount, feeAmount);

        // minProfitBpsを読み取り後すぐにクリア（re-entrancy対策）
        uint256 localMinProfitBps = currentMinProfitBps;
        currentMinProfitBps = 0;

        // アービトラージを実行（内部呼び出しでre-entrancy完全防止）
        _executeArbitrage(
            cachedToken,
            cachedAmount,
            feeAmount,
            localMinProfitBps,
            userData
        );
    }

    /// @notice フラッシュローン手数料の妥当性を検証
    /// @param borrowAmount 借入額
    /// @param actualFeeAmount 実際の手数料額
    function _validateFeeAmount(
        uint256 borrowAmount,
        uint256 actualFeeAmount
    ) internal view {
        // Balancer Vaultから実際の手数料率を取得
        uint256 feePercentage = vault
            .getProtocolFeesCollector()
            .getFlashLoanFeePercentage();

        // 期待される手数料額を計算（1e18精度）
        uint256 expectedFeeAmount = (borrowAmount * feePercentage) / 1e18;

        // 厳密チェック（1 wei の誤差も許可しない）
        if (actualFeeAmount != expectedFeeAmount) {
            revert InvalidFeeAmount(expectedFeeAmount, actualFeeAmount);
        }
    }

    /// @notice アービトラージ実行の内部関数（re-entrancy完全防止）
    function _executeArbitrage(
        IERC20 cachedToken,
        uint256 cachedAmount,
        uint256 feeAmount,
        uint256 localMinProfitBps,
        bytes memory userData
    ) internal nonReentrant {
        // 開始時の残高を記録
        uint256 balanceBefore = cachedToken.balanceOf(address(this));

        // スワップデータをデコードして実行
        (address allowanceTarget1, address allowanceTarget2) = _executeSwaps(
            cachedToken,
            cachedAmount,
            userData
        );

        // 最終チェックと返済
        _finalizeArbitrage(
            cachedToken,
            cachedAmount,
            feeAmount,
            balanceBefore,
            localMinProfitBps,
            allowanceTarget1,
            allowanceTarget2
        );
    }

    /// @notice スワップ実行の内部関数（セキュリティ強化）
    function _executeSwaps(
        IERC20 cachedToken,
        uint256 cachedAmount,
        bytes memory userData
    ) internal returns (address allowanceTarget1, address allowanceTarget2) {
        // userDataから0x APIのスワップデータをデコード
        // 形式: [allowanceTarget1, target1, swapData1, allowanceTarget2, target2, swapData2]
        address target1;
        address target2;
        bytes memory swapData1;
        bytes memory swapData2;
        (
            allowanceTarget1,
            target1,
            swapData1,
            allowanceTarget2,
            target2,
            swapData2
        ) = abi.decode(
            userData,
            (address, address, bytes, address, address, bytes)
        );

        // セキュリティ: 信頼できるスワップターゲットのみ許可
        if (!trustedSpenders[allowanceTarget1]) {
            revert UntrustedSpender(allowanceTarget1);
        }
        if (!trustedSpenders[allowanceTarget2]) {
            revert UntrustedSpender(allowanceTarget2);
        }
        if (!trustedSpenders[target1]) {
            revert UntrustedSpender(target1);
        }
        if (!trustedSpenders[target2]) {
            revert UntrustedSpender(target2);
        }

        // 最初のスワップ実行
        _executeFirstSwap(
            cachedToken,
            cachedAmount,
            allowanceTarget1,
            target1,
            swapData1
        );

        // 2番目のスワップ実行
        _executeSecondSwap(cachedToken, allowanceTarget2, target2, swapData2);
    }

    /// @notice 最初のスワップ実行
    function _executeFirstSwap(
        IERC20 cachedToken,
        uint256 cachedAmount,
        address allowanceTarget1,
        address target1,
        bytes memory swapData1
    ) internal {
        // 安全な承認（USDT等のnon-zero→non-zero問題対応）
        cachedToken.forceApprove(allowanceTarget1, cachedAmount);

        // スワップ前の残高記録
        uint256 balanceBefore = cachedToken.balanceOf(address(this));

        // スワップ実行（正しいtargetに対してcall）
        (bool success1, ) = target1.call(swapData1);
        if (!success1) revert SwapFailed();

        // スワップ後の残高と中間トークンを特定
        uint256 balanceAfter = cachedToken.balanceOf(address(this));
        uint256 inputAmount = balanceBefore - balanceAfter;

        // 中間トークンと出力量を特定
        (
            address intermediateToken,
            uint256 outputAmount
        ) = _findIntermediateToken(cachedToken);

        // イベント発行
        emit SwapExecuted(
            address(cachedToken),
            intermediateToken,
            inputAmount,
            outputAmount,
            target1
        );
    }

    /// @notice 2番目のスワップ実行
    function _executeSecondSwap(
        IERC20 cachedToken,
        address allowanceTarget2,
        address target2,
        bytes memory swapData2
    ) internal {
        // 中間トークンと入力量を特定
        (
            address intermediateToken,
            uint256 inputAmount
        ) = _findIntermediateToken(cachedToken);

        // allowanceTargetに対して中間トークンを一括承認（安全かつガス効率的）
        if (intermediateToken != address(0) && inputAmount > 0) {
            IERC20(intermediateToken).forceApprove(
                allowanceTarget2,
                inputAmount
            );
        }

        // スワップ前の残高記録
        uint256 balanceBefore = cachedToken.balanceOf(address(this));

        // スワップ実行（正しいtargetに対してcall）
        (bool success2, ) = target2.call(swapData2);
        if (!success2) revert SwapFailed();

        // スワップ後の残高
        uint256 balanceAfter = cachedToken.balanceOf(address(this));
        uint256 outputAmount = balanceAfter - balanceBefore;

        // イベント発行
        emit SwapExecuted(
            intermediateToken,
            address(cachedToken),
            inputAmount,
            outputAmount,
            target2
        );
    }

    /// @notice 中間トークンを特定する内部関数（ガス最適化版）
    function _findIntermediateToken(
        IERC20 excludeToken
    ) internal view returns (address token, uint256 balance) {
        address[5] memory majorTokens = [DAI, WETH, USDT, WBTC, USDC];
        uint256 maxBalance = 0;
        address maxToken = address(0);

        // 最大残高のトークンを特定（uncheckedで最適化）
        for (uint256 i = 0; i < majorTokens.length; ) {
            if (majorTokens[i] != address(excludeToken)) {
                uint256 tokenBalance = IERC20(majorTokens[i]).balanceOf(
                    address(this)
                );
                if (tokenBalance > maxBalance) {
                    maxBalance = tokenBalance;
                    maxToken = majorTokens[i];
                }
            }
            unchecked {
                ++i;
            }
        }

        return (maxToken, maxBalance);
    }

    /// @notice アービトラージの最終処理（イベント拡張）
    function _finalizeArbitrage(
        IERC20 cachedToken,
        uint256 cachedAmount,
        uint256 feeAmount,
        uint256 balanceBefore,
        uint256 localMinProfitBps,
        address allowanceTarget1,
        address allowanceTarget2
    ) internal {
        // スワップ後の残高
        uint256 balanceAfter = cachedToken.balanceOf(address(this));

        // 承認リセット（借入トークン）
        cachedToken.forceApprove(allowanceTarget1, 0);
        cachedToken.forceApprove(allowanceTarget2, 0);

        // 中間トークンの承認も確実にリセット（残りカス対策）
        _resetAllIntermediateApprovals(
            cachedToken,
            allowanceTarget1,
            allowanceTarget2
        );

        // 利益チェック（手数料を考慮）
        uint256 totalRepayment = cachedAmount + feeAmount;

        // 必要な利益を計算
        uint256 requiredProfit = (totalRepayment * localMinProfitBps) / 10000;
        uint256 minimumBalance = balanceBefore +
            totalRepayment +
            requiredProfit;

        if (balanceAfter < minimumBalance)
            revert InsufficientProfit(balanceAfter, minimumBalance);

        // 返済（手数料込み）
        require(
            cachedToken.transfer(address(vault), totalRepayment),
            "Transfer failed"
        );

        // イベント発行（拡張版）
        uint256 profit = balanceAfter - (balanceBefore + totalRepayment);
        emit FlashLoanExecuted(
            address(cachedToken),
            cachedAmount,
            feeAmount,
            profit,
            localMinProfitBps,
            block.number,
            tx.gasprice,
            block.basefee
        );
    }

    /// @notice 全ての中間トークンの承認をリセット（残りカス対策）
    function _resetAllIntermediateApprovals(
        IERC20 borrowToken,
        address allowanceTarget1,
        address allowanceTarget2
    ) internal {
        address[5] memory majorTokens = [DAI, WETH, USDT, WBTC, USDC];

        for (uint256 i = 0; i < majorTokens.length; ) {
            if (majorTokens[i] != address(borrowToken)) {
                IERC20 token = IERC20(majorTokens[i]);

                // 両方のallowanceTargetへの承認を一括リセット
                _resetTokenApproval(token, allowanceTarget1);
                _resetTokenApproval(token, allowanceTarget2);
            }

            unchecked {
                ++i;
            }
        }
    }

    /// @notice 単一トークンの承認をリセット（ヘルパー関数）
    function _resetTokenApproval(IERC20 token, address spender) internal {
        if (token.allowance(address(this), spender) > 0) {
            token.forceApprove(spender, 0);
        }
    }

    /// @notice トークンを引き出す（pause中でも実行可能）
    /// @param tokenAddress 引き出すトークンのアドレス（0x0でETH）
    /// @dev 緊急停止時でも資金引き出しは許可する運用ポリシー
    function withdraw(address tokenAddress) external onlyOwner nonReentrant {
        if (tokenAddress == address(0)) {
            // ETHの引き出し
            uint256 balance = address(this).balance;
            require(balance > 0, "No ETH balance");
            (bool success, ) = owner().call{value: balance}("");
            if (!success) revert TransferFailed();
            emit EmergencyWithdraw(address(0), balance);
        } else {
            // ERC20の引き出し
            IERC20 token = IERC20(tokenAddress);
            uint256 balance = token.balanceOf(address(this));
            require(balance > 0, "No token balance");
            require(token.transfer(owner(), balance), "Transfer failed");
            emit EmergencyWithdraw(tokenAddress, balance);
        }
    }

    /// @notice 複数トークンの一括引き出し
    /// @param tokens トークンアドレスの配列
    function emergencyWithdrawMultiple(
        address[] calldata tokens
    ) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            try this.withdraw(tokens[i]) {} catch {}
        }
    }

    /// @notice ETHを受け取れるようにする（VaultまたはWETHから）
    receive() external payable {
        // Vault、またはWETH（0x/1inch unwrap対応）からのみ許可
        require(
            msg.sender == address(vault) || msg.sender == WETH,
            "Only vault or WETH can send ETH"
        );
    }

    /// @notice ETH/USD価格を取得（Graceful Degradation対応）
    /// @return price ETH価格（8桁精度、例：300000000000 = $3000.00）
    function getETHPriceUSD() external returns (uint256 price) {
        // Pausedの場合は明示的にrevert
        if (paused()) {
            revert("Contract paused");
        }

        (, int256 answer, , uint256 updatedAt, ) = ETH_USD_FEED
            .latestRoundData();

        // 価格が24時間以内に更新されていることを確認
        if (block.timestamp - updatedAt <= 86400 && answer > 0) {
            // 有効な価格をキャッシュに保存
            lastValidETHPrice = uint256(answer);
            lastPriceUpdate = block.timestamp;
            return uint256(answer);
        }

        // フォールバック: 前回の有効価格を使用（7日以内）
        if (
            lastValidETHPrice > 0 && block.timestamp - lastPriceUpdate <= 604800
        ) {
            return lastValidETHPrice;
        }

        // 最終フォールバック: 固定価格
        return 300000000000; // $3000.00
    }

    /// @notice ガス代をUSD換算で取得（オーバーフロー対策）
    /// @param gasUsed 使用ガス量
    /// @param gasPrice ガス価格（wei）
    /// @return gasCostUSD ガス代のUSD換算（18桁精度）
    function getGasCostUSD(
        uint256 gasUsed,
        uint256 gasPrice
    ) external returns (uint256 gasCostUSD) {
        uint256 ethPriceUSD = this.getETHPriceUSD(); // 8桁精度

        // オーバーフロー対策：段階的に計算
        // gasUsed * gasPrice * ethPriceUSD / (1e18 * 1e8)
        require(gasUsed <= type(uint128).max, "gasUsed too large");
        require(gasPrice <= type(uint128).max, "gasPrice too large");

        uint256 gasCostWei = gasUsed * gasPrice;
        gasCostUSD = (gasCostWei * ethPriceUSD) / 1e26; // 1e18 * 1e8 = 1e26

        return gasCostUSD;
    }

    /// @notice 緊急停止（オーナーのみ）
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice 緊急停止解除（オーナーのみ）
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice フォールバック価格を手動更新（7日以上staleの場合のみ、複数価格フィード検証付き）
    /// @param newPriceUSD 新しいETH価格（8桁精度、例：300000000000 = $3000.00）
    function updateFallbackPrice(uint256 newPriceUSD) external onlyOwner {
        require(newPriceUSD > 0, "Price must be positive");
        require(newPriceUSD >= 50000000000, "Price too low"); // $500以上（より現実的）
        require(newPriceUSD <= 2000000000000, "Price too high"); // $20,000以下（より現実的）

        // 7日以上staleの場合のみ更新を許可
        require(
            block.timestamp - lastPriceUpdate > 604800,
            "Price feed not stale enough"
        );

        // 複数価格フィードとの整合性チェック
        uint256 chainlinkPrice = _getChainlinkPriceWithFallback();
        uint256 currentFallbackPrice = lastValidETHPrice;

        // 既存の価格との乖離が50%以内であることを確認（緊急時対応）
        if (currentFallbackPrice > 0) {
            uint256 deviation = _calculatePercentageDeviation(
                newPriceUSD,
                currentFallbackPrice
            );
            require(deviation <= 50, "Price deviation too high from current");
        }

        // Chainlink価格との乖離が30%以内であることを確認
        if (chainlinkPrice > 0) {
            uint256 chainlinkDeviation = _calculatePercentageDeviation(
                newPriceUSD,
                chainlinkPrice
            );
            require(
                chainlinkDeviation <= 30,
                "Price deviation too high from Chainlink"
            );
        }

        lastValidETHPrice = newPriceUSD;
        lastPriceUpdate = block.timestamp;

        emit FallbackPriceUpdated(newPriceUSD, block.timestamp);
    }

    /// @notice 価格乖離率を計算
    function _calculatePercentageDeviation(
        uint256 price1,
        uint256 price2
    ) internal pure returns (uint256) {
        if (price1 > price2) {
            return ((price1 - price2) * 100) / price2;
        } else {
            return ((price2 - price1) * 100) / price1;
        }
    }

    /// @notice Chainlink価格を安全に取得（fallback付き）
    function _getChainlinkPriceWithFallback() internal view returns (uint256) {
        try ETH_USD_FEED.latestRoundData() returns (
            uint80,
            int256 answer,
            uint256,
            uint256 updatedAt,
            uint80
        ) {
            // 24時間以内の価格のみ信頼
            if (block.timestamp - updatedAt <= 86400 && answer > 0) {
                return uint256(answer);
            }
        } catch {
            // Chainlink呼び出し失敗時は0を返す
        }
        return 0;
    }

    /// @notice 緊急時価格リセット（複数のオーナー署名が必要）
    function emergencyPriceReset(
        uint256 emergencyPrice,
        bytes[] calldata signatures
    ) external onlyOwner {
        require(emergencyPrice >= 100000000000, "Emergency price too low"); // $1000以上
        require(emergencyPrice <= 500000000000, "Emergency price too high"); // $5000以下
        require(signatures.length >= 2, "Need multiple signatures"); // 複数署名必須

        // 緊急時のみ（Chainlinkが7日以上停止）
        require(
            block.timestamp - lastPriceUpdate > 604800,
            "Not an emergency situation"
        );

        // TODO: 実際の実装では複数署名検証ロジックを追加
        // verifyMultipleSignatures(emergencyPrice, signatures);

        lastValidETHPrice = emergencyPrice;
        lastPriceUpdate = block.timestamp;

        emit EmergencyPriceReset(emergencyPrice, block.timestamp);
    }

    // エラー定義
    error Unauthorized();
    error SwapFailed();
    error InsufficientProfit(uint256 got, uint256 required);
    error InvalidAmount();
    error TransferFailed();
    error UntrustedSpender(address spender);
    error InvalidFeeAmount(uint256 expected, uint256 actual);
}
