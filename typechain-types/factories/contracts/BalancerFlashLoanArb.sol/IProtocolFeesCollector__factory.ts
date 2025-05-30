/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */

import { Contract, Interface, type ContractRunner } from "ethers";
import type {
  IProtocolFeesCollector,
  IProtocolFeesCollectorInterface,
} from "../../../contracts/BalancerFlashLoanArb.sol/IProtocolFeesCollector";

const _abi = [
  {
    inputs: [],
    name: "getFlashLoanFeePercentage",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export class IProtocolFeesCollector__factory {
  static readonly abi = _abi;
  static createInterface(): IProtocolFeesCollectorInterface {
    return new Interface(_abi) as IProtocolFeesCollectorInterface;
  }
  static connect(
    address: string,
    runner?: ContractRunner | null
  ): IProtocolFeesCollector {
    return new Contract(
      address,
      _abi,
      runner
    ) as unknown as IProtocolFeesCollector;
  }
}
