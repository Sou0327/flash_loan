pragma solidity ^0.8.20;

interface IProtocolFeesCollector {
    function getFlashLoanFeePercentage() external view returns (uint256);
}
