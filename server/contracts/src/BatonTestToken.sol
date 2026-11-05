// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only reward token for BATON's Sepolia lifecycle acceptance run.
/// @dev Anyone can mint; never deploy this contract on mainnet or use it as a real asset.
contract BatonTestToken is ERC20 {
    constructor() ERC20("BATON Sepolia Test Token", "BTT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
