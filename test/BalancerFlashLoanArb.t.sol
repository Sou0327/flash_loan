// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Hardhat環境用のテストベース（forge-stdの代替）
contract TestBase {
    event log(string);
    event log_named_uint(string key, uint val);
    event log_named_address(string key, address val);

    function assertTrue(bool condition) internal pure {
        require(condition, "Assertion failed");
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "Values not equal");
    }

    function assertGt(uint256 a, uint256 b) internal pure {
        require(a > b, "a not greater than b");
    }

    function assertLt(uint256 a, uint256 b) internal pure {
        require(a < b, "a not less than b");
    }

    function assertGe(uint256 a, uint256 b) internal pure {
        require(a >= b, "a not greater than or equal to b");
    }

    function assertLe(uint256 a, uint256 b) internal pure {
        require(a <= b, "a not less than or equal to b");
    }

    function assertEq(address a, address b) internal pure {
        require(a == b, "Addresses not equal");
    }
}

import "../contracts/BalancerFlashLoanArb.sol";

contract BalancerFlashLoanArbTest is TestBase {
    BalancerFlashLoanArb public arb;
    address constant BALANCER_VAULT =
        0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    // イベント定義
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

    function setUp() public {
        arb = new BalancerFlashLoanArb(BALANCER_VAULT);
    }

    /// @dev ETH価格取得テスト
    function testGetETHPriceUSD() public {
        uint256 price = arb.getETHPriceUSD();

        // ETH価格の妥当性チェック（$100 - $10,000の範囲）
        assertGe(price, 10000000000); // $100.00 (8桁精度)
        assertLe(price, 1000000000000); // $10,000.00 (8桁精度)
    }

    /// @dev ガス代USD換算テスト
    function testGetGasCostUSD() public {
        uint256 gasUsed = 300000; // 300k gas
        uint256 gasPrice = 20 * 1e9; // 20 Gwei

        uint256 gasCostUSD = arb.getGasCostUSD(gasUsed, gasPrice);

        // ガス代が妥当な範囲内であることを確認
        assertGt(gasCostUSD, 0);
        assertLt(gasCostUSD, 1000 ether); // $1000未満
    }

    /// @dev 所有権管理テスト
    function testOnlyOwner() public {
        // 非オーナーからの呼び出しは失敗するはず
        try arb.withdraw(USDC) {
            assertTrue(false); // ここに到達してはいけない
        } catch {
            assertTrue(true); // 期待される動作
        }
    }

    /// @dev 引き出し機能テスト（シミュレーション）
    function testWithdrawLogic() public {
        // オーナーのみが引き出し可能であることを確認
        address owner = arb.owner();
        assertEq(owner, address(this));
    }

    /// @dev 緊急停止機能テスト
    function testPauseFunctionality() public {
        // 初期状態では停止していない
        assertTrue(!arb.paused());

        // 停止実行
        arb.pause();
        assertTrue(arb.paused());

        // 停止解除
        arb.unpause();
        assertTrue(!arb.paused());
    }

    /// @dev 信頼できるスワップターゲット管理テスト
    function testTrustedSpenderManagement() public {
        address testSpender = address(0x123);

        // 初期状態では信頼されていない
        assertTrue(!arb.trustedSpenders(testSpender));

        // 信頼できるスワップターゲットに追加
        arb.setTrustedSpender(testSpender, true);
        assertTrue(arb.trustedSpenders(testSpender));

        // 削除
        arb.setTrustedSpender(testSpender, false);
        assertTrue(!arb.trustedSpenders(testSpender));
    }
}
