// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol";
import "@balancer-labs/v2-interfaces/contracts/solidity-utils/openzeppelin/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract BalancerFlashLoanArb is IFlashLoanRecipient, Ownable, ReentrancyGuard {
    IVault private immutable vault;

    // 0x Protocol Permit2 Contract
    address public constant PERMIT2_CONTRACT =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // イベント
    event FlashLoanExecuted(
        address indexed token,
        uint256 amount,
        uint256 feeAmount,
        uint256 profit
    );
    event EmergencyWithdraw(address indexed token, uint256 amount);

    // エラー定義
    error Unauthorized();
    error SwapFailed();
    error InsufficientProfit();
    error InvalidAmount();
    error TransferFailed();

    constructor(address _vault) Ownable(msg.sender) {
        vault = IVault(_vault);
    }

    /// @notice フラッシュローンを実行
    /// @param tokens 借りるトークンの配列（通常は1つのトークン）
    /// @param amounts 借りる量の配列
    /// @param swapData 0x Protocolのスワップデータ
    function executeFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory swapData
    ) external onlyOwner nonReentrant {
        require(tokens.length == amounts.length, "Array length mismatch");
        require(tokens.length > 0, "Empty arrays");

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

        // 単一トークンのアービトラージを想定
        IERC20 token = tokens[0];
        uint256 amount = amounts[0];
        uint256 feeAmount = feeAmounts[0];

        // userDataから0x APIのスワップデータをデコード
        (
            address swapTarget1,
            address swapTarget2,
            bytes memory swapData1,
            bytes memory swapData2
        ) = abi.decode(userData, (address, address, bytes, bytes));

        // 最初のスワップのためにPermit2への承認
        require(token.approve(PERMIT2_CONTRACT, amount), "Approval failed");

        // 最初のスワップを実行（例：USDC → DAI）
        (bool success1, ) = swapTarget1.call(swapData1);
        if (!success1) revert SwapFailed();

        // 中間トークン（DAI）の残高を確認し、2番目のスワップのために承認
        // 注意：実際の実装では中間トークンのアドレスを正確に特定する必要がある
        // ここではDAIアドレスをハードコード（改善の余地あり）
        IERC20 intermediateToken = IERC20(
            0x6B175474E89094C44Da98b954EedeAC495271d0F
        ); // DAI
        uint256 intermediateBalance = intermediateToken.balanceOf(
            address(this)
        );

        if (intermediateBalance > 0) {
            require(
                intermediateToken.approve(
                    PERMIT2_CONTRACT,
                    intermediateBalance
                ),
                "Intermediate approval failed"
            );
        }

        // 2番目のスワップを実行（例：DAI → USDC）
        (bool success2, ) = swapTarget2.call(swapData2);
        if (!success2) revert SwapFailed();

        // スワップ後の残高
        uint256 balanceAfter = token.balanceOf(address(this));

        // 利益があることを確認
        // Balancerは手数料無料なので、借入額以上の残高があれば利益
        if (balanceAfter <= amount) revert InsufficientProfit();

        // Balancer Vaultへ返済
        require(token.transfer(address(vault), amount), "Transfer failed");

        // 利益を計算してイベントを発行
        uint256 profit = balanceAfter - amount;
        emit FlashLoanExecuted(address(token), amount, 0, profit);
    }

    /// @notice トークンを引き出す
    /// @param tokenAddress 引き出すトークンのアドレス（0x0でETH）
    function withdraw(address tokenAddress) external onlyOwner {
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

    /// @notice ETHを受け取れるようにする
    receive() external payable {}
}
