// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol";
import "@balancer-labs/v2-interfaces/contracts/solidity-utils/openzeppelin/IERC20.sol";

contract BalancerSimpleFlashLoan is IFlashLoanRecipient {
    IVault private immutable vault;
    address public owner;

    constructor(IVault _vault) {
        vault = _vault;
        owner = msg.sender;
    }

    function executeFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external {
        vault.flashLoan(this, tokens, amounts, userData);
    }

    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        require(msg.sender == address(vault), "Unauthorized");
        // ここでFlashLoanで借りた資金を使用するロジックを実装
        // 現在は単純に借りた金額を返済するだけ

        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20(tokens[i]).transfer(address(vault), amounts[i]);
        }
    }

    function withdrawToken(address tokenAddress) external {
        require(msg.sender == owner, "Only owner can Withdraw");
        IERC20 token = IERC20(tokenAddress);
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No Balance to Withdraw");
        require(token.transfer(owner, balance), "Transfer Failed");
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "Only owner can Transfer Wwnership");
        require(newOwner != address(0), "New owner cannot be Zero Address");
        owner = newOwner;
    }
}
