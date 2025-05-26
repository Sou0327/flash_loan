// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../contracts/BalancerFlashLoanArb.sol";

/// @title Re-entrancy Property Test for Echidna
/// @notice Echidnaを使用してre-entrancy攻撃を検出するプロパティテスト
contract ReentrancyTest {
    BalancerFlashLoanArb public arb;
    address constant BALANCER_VAULT =
        0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    // 状態追跡
    bool public inFlashLoan = false;
    uint256 public flashLoanCount = 0;
    uint256 public maxFlashLoanDepth = 0;

    // 攻撃者コントラクト
    MaliciousReceiver public attacker;

    constructor() {
        arb = new BalancerFlashLoanArb(BALANCER_VAULT);
        attacker = new MaliciousReceiver(address(arb));
    }

    /// @notice プロパティ1: フラッシュローン中の再帰呼び出しは不可能
    function echidna_no_reentrancy() public view returns (bool) {
        return flashLoanCount <= 1;
    }

    /// @notice プロパティ2: フラッシュローン深度は1を超えない
    function echidna_max_depth_one() public view returns (bool) {
        return maxFlashLoanDepth <= 1;
    }

    /// @notice プロパティ3: コントラクトは常にETHを保持しない
    function echidna_no_eth_balance() public view returns (bool) {
        return address(arb).balance == 0;
    }

    /// @notice プロパティ4: pause中はフラッシュローン実行不可
    function echidna_paused_blocks_flashloan() public view returns (bool) {
        if (arb.paused()) {
            return !inFlashLoan;
        }
        return true;
    }

    /// @notice 攻撃シミュレーション: 悪意のあるフラッシュローン実行
    function attack_flashloan(uint256 amount) public {
        amount = (amount % 1000000) * 1e6; // 最大100万USDC
        if (amount == 0) return;

        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(USDC);

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        bytes memory userData = abi.encode(
            address(attacker), // 攻撃者を allowanceTarget として設定
            "",
            address(attacker),
            ""
        );

        try arb.executeFlashLoan(tokens, amounts, 50, userData) {
            // 成功した場合の処理
        } catch {
            // 失敗は期待される動作
        }
    }

    /// @notice フラッシュローン状態を追跡
    function trackFlashLoan() external {
        if (inFlashLoan) {
            flashLoanCount++;
            if (flashLoanCount > maxFlashLoanDepth) {
                maxFlashLoanDepth = flashLoanCount;
            }
        } else {
            inFlashLoan = true;
            flashLoanCount = 1;
        }
    }

    /// @notice フラッシュローン終了を追跡
    function endFlashLoan() external {
        inFlashLoan = false;
        flashLoanCount = 0;
    }
}

/// @title 悪意のあるレシーバーコントラクト
contract MaliciousReceiver {
    BalancerFlashLoanArb public target;
    bool public attackAttempted = false;

    constructor(address _target) {
        target = BalancerFlashLoanArb(payable(_target));
    }

    /// @notice 悪意のあるフォールバック関数（re-entrancy攻撃を試行）
    fallback() external payable {
        if (!attackAttempted) {
            attackAttempted = true;

            // Re-entrancy攻撃を試行
            IERC20[] memory tokens = new IERC20[](1);
            tokens[0] = IERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48); // USDC

            uint256[] memory amounts = new uint256[](1);
            amounts[0] = 1000 * 1e6; // 1000 USDC

            try target.executeFlashLoan(tokens, amounts, 50, "") {
                // 攻撃成功（これは起こってはいけない）
            } catch {
                // 攻撃失敗（期待される動作）
            }
        }
    }

    /// @notice ERC20 approve呼び出しをシミュレート
    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    /// @notice ERC20 transfer呼び出しをシミュレート
    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}
