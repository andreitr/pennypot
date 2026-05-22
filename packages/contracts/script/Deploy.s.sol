// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PennyPot} from "../src/PennyPot.sol";

/// @notice Deploys PennyPot. Defaults target Base mainnet (chain ID 8453); override
///         any value via environment variables:
///   USDC_ADDRESS    - USDC token            (default: Base USDC)
///   JACKPOT_ADDRESS - Megapot Jackpot       (default: Base Jackpot)
///   FEE_RECEIVER    - Megapot referrer that earns referral fees + win share
///                     (default: PennyPot's canonical referral address)
///   OWNER_ADDRESS   - initial owner         (default: the broadcaster)
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast --verify
contract Deploy is Script {
    // Base mainnet (chain ID 8453). Source: https://llms.megapot.io/
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_JACKPOT = 0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2;

    /// @notice Canonical PennyPot referral address listed as the Megapot referrer on
    ///         every ticket buy (matches the contract's feeReceiver wiring).
    address internal constant REFERRAL_RECEIVER = 0xDAdA5bAd8cdcB9e323d0606d081E6Dc5D3a577a1;

    function run() external returns (PennyPot pennyPot) {
        address usdc = vm.envOr("USDC_ADDRESS", BASE_USDC);
        address jackpot = vm.envOr("JACKPOT_ADDRESS", BASE_JACKPOT);
        address feeReceiver = vm.envOr("FEE_RECEIVER", REFERRAL_RECEIVER);
        address owner = vm.envOr("OWNER_ADDRESS", msg.sender);

        vm.startBroadcast();
        pennyPot = new PennyPot(usdc, jackpot, feeReceiver, owner);
        vm.stopBroadcast();

        console.log("PennyPot deployed at:", address(pennyPot));
        console.log("  USDC:        ", usdc);
        console.log("  Jackpot:     ", jackpot);
        console.log("  feeReceiver: ", feeReceiver);
        console.log("  owner:       ", owner);
    }
}
