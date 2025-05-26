// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol";
import "@balancer-labs/v2-interfaces/contracts/solidity-utils/openzeppelin/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Chainlink価格フィード
interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 price,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

// SafeERC20の簡易実装（forceApprove用）
library SafeERC20 {
    function forceApprove(
        IERC20 token,
        address spender,
        uint256 value
    ) internal {
        // 最初に0にリセット（USDT等対応）
        if (value > 0 && token.allowance(address(this), spender) > 0) {
            (bool resetSuccess, bytes memory resetData) = address(token).call(
                abi.encodeWithSelector(token.approve.selector, spender, 0)
            );
            require(
                resetSuccess &&
                    (resetData.length == 0 || abi.decode(resetData, (bool))),
                "Reset approval failed"
            );
        }

        // 実際の承認
        (bool success, bytes memory returndata) = address(token).call(
            abi.encodeWithSelector(token.approve.selector, spender, value)
        );
        require(
            success &&
                (returndata.length == 0 || abi.decode(returndata, (bool))),
            "Approval failed"
        );
    }
}

contract BalancerFlashLoanArb is IFlashLoanRecipient, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

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

    // イベント
    event FlashLoanExecuted(
        address indexed token,
        uint256 amount,
        uint256 feeAmount,
        uint256 profit
    );
    event SwapExecuted(
        address indexed srcToken,
        address indexed dstToken,
        uint256 inAmount,
        uint256 outAmount,
        address indexed target
    );
    event EmergencyWithdraw(address indexed token, uint256 amount);

    // エラー定義
    error Unauthorized();
    error SwapFailed();
    error InsufficientProfit();
    error InvalidAmount();
    error TransferFailed();

    // 状態変数を追加
    uint256 private currentMinProfitBps;

    constructor(address _vault) Ownable(msg.sender) {
        vault = IVault(_vault);
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
    ) external onlyOwner nonReentrant {
        require(tokens.length == amounts.length, "Array length mismatch");
        require(tokens.length == 1, "Only single token flash loan supported");
        require(amounts[0] > 0, "Amount must be greater than zero");
        require(minProfitBps <= 1000, "Max 10% slippage"); // 最大10%

        // minProfitBpsを保存
        currentMinProfitBps = minProfitBps;

        // Balancerのフラッシュローンを実行
        vault.flashLoan(this, tokens, amounts, swapData);
    }

    /// @notice Balancerが呼び出すコールバック関数
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        // Balancer Vaultからの呼び出しのみ許可
        if (msg.sender != address(vault)) revert Unauthorized();

        // minProfitBpsが初期化されていることを確認
        require(currentMinProfitBps != 0, "MinProfitBps not initialized");

        // 単一トークンのアービトラージを想定
        IERC20 cachedToken = tokens[0]; // ガス最適化：storage読み取り削減
        uint256 cachedAmount = amounts[0];

        // minProfitBpsを読み取り後すぐにクリア（re-entrancy対策）
        uint256 localMinProfitBps = currentMinProfitBps;
        currentMinProfitBps = 0;

        // アービトラージを実行（エラー時も確実にクリア済み）
        try
            this._executeArbitrageExternal(
                cachedToken,
                cachedAmount,
                feeAmounts[0],
                localMinProfitBps,
                userData
            )
        {
            // 成功時は何もしない
        } catch (bytes memory reason) {
            // エラー時もcurrentMinProfitBpsは既にクリア済み
            assembly {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    /// @notice 外部呼び出し用のラッパー関数（try-catch用）
    function _executeArbitrageExternal(
        IERC20 cachedToken,
        uint256 cachedAmount,
        uint256 feeAmount,
        uint256 localMinProfitBps,
        bytes memory userData
    ) external {
        require(msg.sender == address(this), "Only self call");
        _executeArbitrage(
            cachedToken,
            cachedAmount,
            feeAmount,
            localMinProfitBps,
            userData
        );
    }

    /// @notice アービトラージ実行の内部関数
    function _executeArbitrage(
        IERC20 cachedToken,
        uint256 cachedAmount,
        uint256 feeAmount,
        uint256 localMinProfitBps,
        bytes memory userData
    ) internal {
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

    /// @notice スワップ実行の内部関数
    function _executeSwaps(
        IERC20 cachedToken,
        uint256 cachedAmount,
        bytes memory userData
    ) internal returns (address allowanceTarget1, address allowanceTarget2) {
        // userDataから0x APIのスワップデータをデコード
        bytes memory swapData1;
        bytes memory swapData2;
        (allowanceTarget1, swapData1, allowanceTarget2, swapData2) = abi.decode(
            userData,
            (address, bytes, address, bytes)
        );

        // 最初のスワップ実行
        _executeFirstSwap(
            cachedToken,
            cachedAmount,
            allowanceTarget1,
            swapData1
        );

        // 2番目のスワップ実行
        _executeSecondSwap(cachedToken, allowanceTarget2, swapData2);
    }

    /// @notice 最初のスワップ実行
    function _executeFirstSwap(
        IERC20 cachedToken,
        uint256 cachedAmount,
        address allowanceTarget1,
        bytes memory swapData1
    ) internal {
        // 安全な承認（USDT等のnon-zero→non-zero問題対応）
        cachedToken.forceApprove(allowanceTarget1, cachedAmount);

        // スワップ前の残高記録
        uint256 balanceBefore = cachedToken.balanceOf(address(this));

        // スワップ実行
        (bool success1, ) = allowanceTarget1.call(swapData1);
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
            allowanceTarget1
        );
    }

    /// @notice 2番目のスワップ実行
    function _executeSecondSwap(
        IERC20 cachedToken,
        address allowanceTarget2,
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

        // スワップ実行
        (bool success2, ) = allowanceTarget2.call(swapData2);
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
            allowanceTarget2
        );
    }

    /// @notice 中間トークンを特定する内部関数（残高変化ベース）
    function _findIntermediateToken(
        IERC20 excludeToken
    ) internal view returns (address token, uint256 balance) {
        address[4] memory checkTokens = [DAI, WETH, USDT, WBTC];
        uint256 maxBalance = 0;
        address maxToken = address(0);

        // 最大残高のトークンを特定（複数トークン対応）
        for (uint256 i = 0; i < checkTokens.length; i++) {
            if (checkTokens[i] != address(excludeToken)) {
                uint256 tokenBalance = IERC20(checkTokens[i]).balanceOf(
                    address(this)
                );
                if (tokenBalance > maxBalance) {
                    maxBalance = tokenBalance;
                    maxToken = checkTokens[i];
                }
            }
        }

        return (maxToken, maxBalance);
    }

    /// @notice アービトラージの最終処理
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

        if (balanceAfter < minimumBalance) revert InsufficientProfit();

        // 返済（手数料込み）
        require(
            cachedToken.transfer(address(vault), totalRepayment),
            "Transfer failed"
        );

        // イベント発行
        uint256 profit = balanceAfter - (balanceBefore + totalRepayment);
        emit FlashLoanExecuted(
            address(cachedToken),
            cachedAmount,
            feeAmount,
            profit
        );
    }

    /// @notice 全ての中間トークンの承認をリセット（残りカス対策）
    function _resetAllIntermediateApprovals(
        IERC20 borrowToken,
        address allowanceTarget1,
        address allowanceTarget2
    ) internal {
        address[5] memory majorTokens = [DAI, WETH, USDT, WBTC, USDC];

        for (uint256 i = 0; i < majorTokens.length; i++) {
            if (majorTokens[i] == address(borrowToken)) continue;

            IERC20 token = IERC20(majorTokens[i]);

            // 両方のallowanceTargetへの承認を一括リセット
            _resetTokenApproval(token, allowanceTarget1);
            _resetTokenApproval(token, allowanceTarget2);
        }
    }

    /// @notice 単一トークンの承認をリセット（ヘルパー関数）
    function _resetTokenApproval(IERC20 token, address spender) internal {
        if (token.allowance(address(this), spender) > 0) {
            token.forceApprove(spender, 0);
        }
    }

    /// @notice トークンを引き出す
    /// @param tokenAddress 引き出すトークンのアドレス（0x0でETH）
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

    /// @notice ETH/USD価格を取得（Chainlink）
    /// @return price ETH価格（8桁精度、例：300000000000 = $3000.00）
    function getETHPriceUSD() external view returns (uint256 price) {
        (, int256 answer, , uint256 updatedAt, ) = ETH_USD_FEED
            .latestRoundData();

        // 価格が24時間以内に更新されていることを確認
        require(block.timestamp - updatedAt <= 86400, "Price data too old");
        require(answer > 0, "Invalid price");

        return uint256(answer); // 8桁精度（例：300000000000 = $3000.00）
    }

    /// @notice ガス代をUSD換算で取得（オーバーフロー対策）
    /// @param gasUsed 使用ガス量
    /// @param gasPrice ガス価格（wei）
    /// @return gasCostUSD ガス代のUSD換算（18桁精度）
    function getGasCostUSD(
        uint256 gasUsed,
        uint256 gasPrice
    ) external view returns (uint256 gasCostUSD) {
        uint256 ethPriceUSD = this.getETHPriceUSD(); // 8桁精度

        // オーバーフロー対策：段階的に計算
        // gasUsed * gasPrice * ethPriceUSD / (1e18 * 1e8)
        require(gasUsed <= type(uint128).max, "gasUsed too large");
        require(gasPrice <= type(uint128).max, "gasPrice too large");

        uint256 gasCostWei = gasUsed * gasPrice;
        gasCostUSD = (gasCostWei * ethPriceUSD) / 1e26; // 1e18 * 1e8 = 1e26

        return gasCostUSD;
    }
}
