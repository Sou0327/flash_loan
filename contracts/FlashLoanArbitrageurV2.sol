// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

//import "@openzeppelin/contracts/token/ERC20/IERC20.sol"; # safeERC20ライブラリへ移行
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IVault {
    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

interface IRouter {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

contract FlashLoanArbitrageurV2 is
    IFlashLoanRecipient,
    ReentrancyGuard,
    Ownable
{
    using SafeERC20 for IERC20;

    IVault private immutable vault;

    event LoanExecuted(uint256 borrowed, uint256 returned, uint256 profit);
    event BalanceInfo(
        uint256 initialBalance,
        uint256 finalBalance,
        uint256 amountToRepay
    );
    event SwapExecuted(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 amountOutMin
    );
    event ArbitrageStepCompleted(uint256 step, uint256 currentAmount);
    event ETHWithdrawn(address to, uint256 amount);
    event EmergencyExit(address token, uint256 amount);

    constructor(address _vault) Ownable(msg.sender) {
        vault = IVault(_vault);
    }

    struct ArbitrageParams {
        address[] tokens;
        address[] routers;
        bool[] useFeeOnTransfer;
        uint256[] slippageTolerances;
    }

    function executeFlashLoanArbitrage(
        address assetToBorrow,
        uint256 amountToBorrow,
        address[] calldata tokens,
        address[] calldata routers,
        bool[] calldata useFeeOnTransfer,
        uint256[] calldata slippageTolerances
    ) external onlyOwner nonReentrant {
        require(tokens.length == routers.length + 1, "Invalid Tokens Length");
        require(
            routers.length == useFeeOnTransfer.length,
            "Invalid Routers or useFeeOnTransfer Length"
        );
        require(
            routers.length == slippageTolerances.length,
            "Invalid slippageTolerances Length"
        );

        ArbitrageParams memory params = ArbitrageParams(
            tokens,
            routers,
            useFeeOnTransfer,
            slippageTolerances
        );
        bytes memory encodedParams = abi.encode(params);

        IERC20[] memory assets = new IERC20[](1);
        assets[0] = IERC20(assetToBorrow);

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amountToBorrow;

        vault.flashLoan(this, assets, amounts, encodedParams);
    }

    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory /* feeAmounts */,
        bytes memory userData
    ) external override {
        require(msg.sender == address(vault), "Caller Must be Balancer Vault");

        ArbitrageParams memory arbitrageParams = abi.decode(
            userData,
            (ArbitrageParams)
        );

        uint256 amountToRepay = amounts[0];
        uint256 initialBalance = tokens[0].balanceOf(address(this));

        emit BalanceInfo(initialBalance, 0, amountToRepay);

        uint256 amountReturned = _executeArbitrage(amounts[0], arbitrageParams);

        uint256 finalBalance = tokens[0].balanceOf(address(this));
        emit BalanceInfo(initialBalance, finalBalance, amountToRepay);

        if (finalBalance >= amountToRepay) {
            tokens[0].safeTransfer(address(vault), amountToRepay);

            uint256 profit = finalBalance - amountToRepay;
            if (profit > 0 && finalBalance > amountToRepay + profit) {
                tokens[0].safeTransfer(owner(), profit);
            }

            emit LoanExecuted(amounts[0], amountReturned, profit);
        } else {
            revert("Not Enough Funds to Repay FlashLoan");
        }
    }

    function _executeArbitrage(
        uint256 amount,
        ArbitrageParams memory params
    ) internal returns (uint256) {
        uint256 currentAmount = amount;
        for (uint i = 0; i < params.routers.length; i++) {
            currentAmount = _swapTokens(
                params.tokens[i],
                params.tokens[i + 1],
                currentAmount,
                params.routers[i],
                params.useFeeOnTransfer[i],
                params.slippageTolerances[i]
            );
            emit ArbitrageStepCompleted(i, currentAmount);
        }

        return currentAmount;
    }

    function _swapTokens(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address router,
        bool useFeeOnTransfer,
        uint256 slippageTolerance
    ) internal returns (uint256) {
        require(
            slippageTolerance <= 10000,
            "Slippage Tolerance Must be <= 100%"
        );
        IERC20(tokenIn).safeIncreaseAllowance(router, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256 amountOutMin = (amountIn * (10000 - slippageTolerance)) / 10000;

        uint256 amountOut;
        if (useFeeOnTransfer) {
            IRouter(router)
                .swapExactTokensForTokensSupportingFeeOnTransferTokens(
                    amountIn,
                    amountOutMin,
                    path,
                    address(this),
                    block.timestamp
                );
            amountOut = IERC20(tokenOut).balanceOf(address(this));
        } else {
            uint[] memory amounts = IRouter(router).swapExactTokensForTokens(
                amountIn,
                amountOutMin,
                path,
                address(this),
                block.timestamp
            );
            amountOut = amounts[amounts.length - 1];
        }

        emit SwapExecuted(tokenIn, tokenOut, amountIn, amountOut, amountOutMin);

        return amountOut;
    }

    function withdrawToken(
        address token,
        uint256 amount
    ) external onlyOwner nonReentrant {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance >= amount, "Insufficient Balance");
        IERC20(token).safeTransfer(owner(), amount);
    }

    function withdrawETH(address payable to) external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH Balance");
        (bool success, ) = to.call{value: balance}("");
        require(success, "ETH Transfer Failed!!!");
        emit ETHWithdrawn(to, balance);
    }

    // 救済用関数
    function emergencyExit(address token) external onlyOwner nonReentrant {
        uint256 balance;
        if (token == address(0)) {
            balance = address(this).balance;
            (bool success, ) = owner().call{value: balance}("");
            require(success, "ETH Transfer Failed");
        } else {
            balance = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransfer(owner(), balance);
        }
        emit EmergencyExit(token, balance);
    }

    receive() external payable {}
}
