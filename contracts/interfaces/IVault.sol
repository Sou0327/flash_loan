pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IProtocolFeesCollector.sol";

interface IVault {
    function flashLoan(
        address recipient,
        IERC20[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;

    function getProtocolFeesCollector()
        external
        view
        returns (IProtocolFeesCollector);
}
