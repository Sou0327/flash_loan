// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

library ForceApprove {
    using SafeERC20 for IERC20;

    function forceApprove(
        IERC20 token,
        address spender,
        uint256 value
    ) internal {
        if (value > 0 && token.allowance(address(this), spender) > 0) {
            token.safeApprove(spender, 0);
        }
        token.safeApprove(spender, value);
    }
}
