/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */
import type {
  BaseContract,
  BigNumberish,
  BytesLike,
  FunctionFragment,
  Result,
  Interface,
  EventFragment,
  AddressLike,
  ContractRunner,
  ContractMethod,
  Listener,
} from "ethers";
import type {
  TypedContractEvent,
  TypedDeferredTopicFilter,
  TypedEventLog,
  TypedLogDescription,
  TypedListener,
  TypedContractMethod,
} from "../common";

export interface BalancerFlashLoanArbInterface extends Interface {
  getFunction(
    nameOrSignature:
      | "PERMIT2_CONTRACT"
      | "emergencyWithdrawMultiple"
      | "executeFlashLoan"
      | "owner"
      | "receiveFlashLoan"
      | "renounceOwnership"
      | "transferOwnership"
      | "withdraw"
  ): FunctionFragment;

  getEvent(
    nameOrSignatureOrTopic:
      | "EmergencyWithdraw"
      | "FlashLoanExecuted"
      | "OwnershipTransferred"
  ): EventFragment;

  encodeFunctionData(
    functionFragment: "PERMIT2_CONTRACT",
    values?: undefined
  ): string;
  encodeFunctionData(
    functionFragment: "emergencyWithdrawMultiple",
    values: [AddressLike[]]
  ): string;
  encodeFunctionData(
    functionFragment: "executeFlashLoan",
    values: [AddressLike[], BigNumberish[], BytesLike]
  ): string;
  encodeFunctionData(functionFragment: "owner", values?: undefined): string;
  encodeFunctionData(
    functionFragment: "receiveFlashLoan",
    values: [AddressLike[], BigNumberish[], BigNumberish[], BytesLike]
  ): string;
  encodeFunctionData(
    functionFragment: "renounceOwnership",
    values?: undefined
  ): string;
  encodeFunctionData(
    functionFragment: "transferOwnership",
    values: [AddressLike]
  ): string;
  encodeFunctionData(
    functionFragment: "withdraw",
    values: [AddressLike]
  ): string;

  decodeFunctionResult(
    functionFragment: "PERMIT2_CONTRACT",
    data: BytesLike
  ): Result;
  decodeFunctionResult(
    functionFragment: "emergencyWithdrawMultiple",
    data: BytesLike
  ): Result;
  decodeFunctionResult(
    functionFragment: "executeFlashLoan",
    data: BytesLike
  ): Result;
  decodeFunctionResult(functionFragment: "owner", data: BytesLike): Result;
  decodeFunctionResult(
    functionFragment: "receiveFlashLoan",
    data: BytesLike
  ): Result;
  decodeFunctionResult(
    functionFragment: "renounceOwnership",
    data: BytesLike
  ): Result;
  decodeFunctionResult(
    functionFragment: "transferOwnership",
    data: BytesLike
  ): Result;
  decodeFunctionResult(functionFragment: "withdraw", data: BytesLike): Result;
}

export namespace EmergencyWithdrawEvent {
  export type InputTuple = [token: AddressLike, amount: BigNumberish];
  export type OutputTuple = [token: string, amount: bigint];
  export interface OutputObject {
    token: string;
    amount: bigint;
  }
  export type Event = TypedContractEvent<InputTuple, OutputTuple, OutputObject>;
  export type Filter = TypedDeferredTopicFilter<Event>;
  export type Log = TypedEventLog<Event>;
  export type LogDescription = TypedLogDescription<Event>;
}

export namespace FlashLoanExecutedEvent {
  export type InputTuple = [
    token: AddressLike,
    amount: BigNumberish,
    feeAmount: BigNumberish,
    profit: BigNumberish
  ];
  export type OutputTuple = [
    token: string,
    amount: bigint,
    feeAmount: bigint,
    profit: bigint
  ];
  export interface OutputObject {
    token: string;
    amount: bigint;
    feeAmount: bigint;
    profit: bigint;
  }
  export type Event = TypedContractEvent<InputTuple, OutputTuple, OutputObject>;
  export type Filter = TypedDeferredTopicFilter<Event>;
  export type Log = TypedEventLog<Event>;
  export type LogDescription = TypedLogDescription<Event>;
}

export namespace OwnershipTransferredEvent {
  export type InputTuple = [previousOwner: AddressLike, newOwner: AddressLike];
  export type OutputTuple = [previousOwner: string, newOwner: string];
  export interface OutputObject {
    previousOwner: string;
    newOwner: string;
  }
  export type Event = TypedContractEvent<InputTuple, OutputTuple, OutputObject>;
  export type Filter = TypedDeferredTopicFilter<Event>;
  export type Log = TypedEventLog<Event>;
  export type LogDescription = TypedLogDescription<Event>;
}

export interface BalancerFlashLoanArb extends BaseContract {
  connect(runner?: ContractRunner | null): BalancerFlashLoanArb;
  waitForDeployment(): Promise<this>;

  interface: BalancerFlashLoanArbInterface;

  queryFilter<TCEvent extends TypedContractEvent>(
    event: TCEvent,
    fromBlockOrBlockhash?: string | number | undefined,
    toBlock?: string | number | undefined
  ): Promise<Array<TypedEventLog<TCEvent>>>;
  queryFilter<TCEvent extends TypedContractEvent>(
    filter: TypedDeferredTopicFilter<TCEvent>,
    fromBlockOrBlockhash?: string | number | undefined,
    toBlock?: string | number | undefined
  ): Promise<Array<TypedEventLog<TCEvent>>>;

  on<TCEvent extends TypedContractEvent>(
    event: TCEvent,
    listener: TypedListener<TCEvent>
  ): Promise<this>;
  on<TCEvent extends TypedContractEvent>(
    filter: TypedDeferredTopicFilter<TCEvent>,
    listener: TypedListener<TCEvent>
  ): Promise<this>;

  once<TCEvent extends TypedContractEvent>(
    event: TCEvent,
    listener: TypedListener<TCEvent>
  ): Promise<this>;
  once<TCEvent extends TypedContractEvent>(
    filter: TypedDeferredTopicFilter<TCEvent>,
    listener: TypedListener<TCEvent>
  ): Promise<this>;

  listeners<TCEvent extends TypedContractEvent>(
    event: TCEvent
  ): Promise<Array<TypedListener<TCEvent>>>;
  listeners(eventName?: string): Promise<Array<Listener>>;
  removeAllListeners<TCEvent extends TypedContractEvent>(
    event?: TCEvent
  ): Promise<this>;

  PERMIT2_CONTRACT: TypedContractMethod<[], [string], "view">;

  emergencyWithdrawMultiple: TypedContractMethod<
    [tokens: AddressLike[]],
    [void],
    "nonpayable"
  >;

  executeFlashLoan: TypedContractMethod<
    [tokens: AddressLike[], amounts: BigNumberish[], swapData: BytesLike],
    [void],
    "nonpayable"
  >;

  owner: TypedContractMethod<[], [string], "view">;

  receiveFlashLoan: TypedContractMethod<
    [
      tokens: AddressLike[],
      amounts: BigNumberish[],
      feeAmounts: BigNumberish[],
      userData: BytesLike
    ],
    [void],
    "nonpayable"
  >;

  renounceOwnership: TypedContractMethod<[], [void], "nonpayable">;

  transferOwnership: TypedContractMethod<
    [newOwner: AddressLike],
    [void],
    "nonpayable"
  >;

  withdraw: TypedContractMethod<
    [tokenAddress: AddressLike],
    [void],
    "nonpayable"
  >;

  getFunction<T extends ContractMethod = ContractMethod>(
    key: string | FunctionFragment
  ): T;

  getFunction(
    nameOrSignature: "PERMIT2_CONTRACT"
  ): TypedContractMethod<[], [string], "view">;
  getFunction(
    nameOrSignature: "emergencyWithdrawMultiple"
  ): TypedContractMethod<[tokens: AddressLike[]], [void], "nonpayable">;
  getFunction(
    nameOrSignature: "executeFlashLoan"
  ): TypedContractMethod<
    [tokens: AddressLike[], amounts: BigNumberish[], swapData: BytesLike],
    [void],
    "nonpayable"
  >;
  getFunction(
    nameOrSignature: "owner"
  ): TypedContractMethod<[], [string], "view">;
  getFunction(
    nameOrSignature: "receiveFlashLoan"
  ): TypedContractMethod<
    [
      tokens: AddressLike[],
      amounts: BigNumberish[],
      feeAmounts: BigNumberish[],
      userData: BytesLike
    ],
    [void],
    "nonpayable"
  >;
  getFunction(
    nameOrSignature: "renounceOwnership"
  ): TypedContractMethod<[], [void], "nonpayable">;
  getFunction(
    nameOrSignature: "transferOwnership"
  ): TypedContractMethod<[newOwner: AddressLike], [void], "nonpayable">;
  getFunction(
    nameOrSignature: "withdraw"
  ): TypedContractMethod<[tokenAddress: AddressLike], [void], "nonpayable">;

  getEvent(
    key: "EmergencyWithdraw"
  ): TypedContractEvent<
    EmergencyWithdrawEvent.InputTuple,
    EmergencyWithdrawEvent.OutputTuple,
    EmergencyWithdrawEvent.OutputObject
  >;
  getEvent(
    key: "FlashLoanExecuted"
  ): TypedContractEvent<
    FlashLoanExecutedEvent.InputTuple,
    FlashLoanExecutedEvent.OutputTuple,
    FlashLoanExecutedEvent.OutputObject
  >;
  getEvent(
    key: "OwnershipTransferred"
  ): TypedContractEvent<
    OwnershipTransferredEvent.InputTuple,
    OwnershipTransferredEvent.OutputTuple,
    OwnershipTransferredEvent.OutputObject
  >;

  filters: {
    "EmergencyWithdraw(address,uint256)": TypedContractEvent<
      EmergencyWithdrawEvent.InputTuple,
      EmergencyWithdrawEvent.OutputTuple,
      EmergencyWithdrawEvent.OutputObject
    >;
    EmergencyWithdraw: TypedContractEvent<
      EmergencyWithdrawEvent.InputTuple,
      EmergencyWithdrawEvent.OutputTuple,
      EmergencyWithdrawEvent.OutputObject
    >;

    "FlashLoanExecuted(address,uint256,uint256,uint256)": TypedContractEvent<
      FlashLoanExecutedEvent.InputTuple,
      FlashLoanExecutedEvent.OutputTuple,
      FlashLoanExecutedEvent.OutputObject
    >;
    FlashLoanExecuted: TypedContractEvent<
      FlashLoanExecutedEvent.InputTuple,
      FlashLoanExecutedEvent.OutputTuple,
      FlashLoanExecutedEvent.OutputObject
    >;

    "OwnershipTransferred(address,address)": TypedContractEvent<
      OwnershipTransferredEvent.InputTuple,
      OwnershipTransferredEvent.OutputTuple,
      OwnershipTransferredEvent.OutputObject
    >;
    OwnershipTransferred: TypedContractEvent<
      OwnershipTransferredEvent.InputTuple,
      OwnershipTransferredEvent.OutputTuple,
      OwnershipTransferredEvent.OutputObject
    >;
  };
}
