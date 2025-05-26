// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/BalancerFlashLoanArb.sol";

contract BalancerFlashLoanArbTest is Test {
    BalancerFlashLoanArb public arb;
    address constant BALANCER_VAULT =
        0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    function setUp() public {
        // Mainnetをフォーク
        vm.createFork(vm.envString("MAINNET_RPC"));

        arb = new BalancerFlashLoanArb(BALANCER_VAULT);
    }

    /// @dev Fuzzテスト：ETH価格取得
    function testFuzz_GetETHPriceUSD(uint256 timestamp) public {
        // 現在時刻から24時間以内の範囲でテスト
        timestamp = bound(timestamp, block.timestamp - 86400, block.timestamp);
        vm.warp(timestamp);

        uint256 price = arb.getETHPriceUSD();

        // ETH価格の妥当性チェック（$100 - $10,000の範囲）
        assertGe(price, 10000000000); // $100.00 (8桁精度)
        assertLe(price, 1000000000000); // $10,000.00 (8桁精度)
    }

    /// @dev Fuzzテスト：ガス代USD換算
    function testFuzz_GetGasCostUSD(uint256 gasUsed, uint256 gasPrice) public {
        // 現実的な範囲に制限
        gasUsed = bound(gasUsed, 21000, 1000000); // 21k - 1M gas
        gasPrice = bound(gasPrice, 1 gwei, 100 gwei); // 1-100 Gwei

        uint256 gasCostUSD = arb.getGasCostUSD(gasUsed, gasPrice);

        // ガス代が妥当な範囲内であることを確認
        assertGt(gasCostUSD, 0);
        assertLt(gasCostUSD, 1000 ether); // $1000未満
    }

    /// @dev Fuzzテスト：所有権管理
    function testFuzz_OnlyOwner(address caller) public {
        vm.assume(caller != address(this));

        vm.prank(caller);
        vm.expectRevert();
        arb.withdraw(USDC);
    }

    /// @dev Fuzzテスト：引き出し機能
    function testFuzz_Withdraw(uint256 amount) public {
        amount = bound(amount, 1, 1000000 * 1e6); // 1 - 1M USDC

        // USDCをコントラクトに送金
        deal(USDC, address(arb), amount);

        uint256 balanceBefore = IERC20(USDC).balanceOf(address(this));

        arb.withdraw(USDC);

        uint256 balanceAfter = IERC20(USDC).balanceOf(address(this));
        assertEq(balanceAfter - balanceBefore, amount);
    }

    /// @dev 不変条件テスト：コントラクトは常にETHを保持しない
    function invariant_NoETHBalance() public {
        assertEq(address(arb).balance, 0);
    }
}
