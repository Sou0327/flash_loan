// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract FlashLoanArb is FlashLoanSimpleReceiverBase {
    address public owner;

    constructor(
        address provider
    ) FlashLoanSimpleReceiverBase(IPoolAddressesProvider(provider)) {
        owner = msg.sender;
    }

    /// @notice フラッシュローン開始トリガ
    function start(
        address asset,
        uint256 amount,
        bytes calldata oneInchData
    ) external {
        require(msg.sender == owner, "only owner");
        POOL.flashLoanSimple(address(this), asset, amount, oneInchData, 0);
    }

    /// @dev Aave が自動で呼ぶ
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address,
        bytes calldata oneInchData
    ) external override returns (bool) {
        // 1inch で最適経路スワップ（買い → 売り）
        (bool ok, ) = 0x1111111254EEB25477B68fb85Ed929f73A960582.call(
            oneInchData
        );
        require(ok, "swap failed");

        // 返済額を承認
        uint256 debt = amount + premium;
        IERC20(asset).approve(address(POOL), debt);

        // 残高差分が純利益
        return true;
    }

    function withdraw(address token) external {
        require(msg.sender == owner);
        IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this)));
    }
}
