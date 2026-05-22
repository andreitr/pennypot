// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PennyPot} from "../src/PennyPot.sol";

/// @notice Deploys PennyPot. Configure via environment variables:
///   USDC_ADDRESS    - USDC token on the target chain
///   JACKPOT_ADDRESS - Megapot Jackpot contract
///   FEE_RECEIVER    - operator address that collects Megapot referral fees
///   OWNER_ADDRESS   - initial owner (optional; defaults to the broadcaster)
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast --verify
contract Deploy is Script {
    function run() external returns (PennyPot pennyPot) {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address jackpot = vm.envAddress("JACKPOT_ADDRESS");
        address feeReceiver = vm.envAddress("FEE_RECEIVER");
        address owner = vm.envOr("OWNER_ADDRESS", msg.sender);

        vm.startBroadcast();
        pennyPot = new PennyPot(usdc, jackpot, feeReceiver, owner);
        vm.stopBroadcast();

        console.log("PennyPot deployed at:", address(pennyPot));
    }
}
