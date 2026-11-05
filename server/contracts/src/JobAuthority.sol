// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ENSv2 Permissioned Resolver's Enhanced Access Control role reader.
interface IENSScopedPermissionResolver {
    function roles(uint256 resource, address account) external view returns (uint256);
}

contract JobAuthority {
    error ResolverUnset();
    error ResolverCallFailed();

    /// @dev ENS Permissioned Resolver ROLE_SET_DATA (1 << 24).
    uint256 public constant ROLE_SET_DATA = 1 << 24;
    bytes16 private constant HEX_DIGITS = "0123456789abcdef";
    bytes private constant JOB_KEY_PREFIX = "baton.job.v1:";

    /// @notice The actual ENS resolver proxy, distinct from this BATON adapter's address.
    address public immutable ensResolver;

    constructor(address ensResolver_) {
        if (ensResolver_ == address(0)) revert ResolverUnset();
        ensResolver = ensResolver_;
    }

    /// @notice Stable ENS data key used to represent a BATON job grant.
    function jobGrantKey(bytes32 jobId) public pure returns (string memory) {
        bytes memory key = new bytes(JOB_KEY_PREFIX.length + 64);
        for (uint256 i; i < JOB_KEY_PREFIX.length; ++i) {
            key[i] = JOB_KEY_PREFIX[i];
        }
        for (uint256 i; i < 32; ++i) {
            uint8 value = uint8(jobId[i]);
            key[JOB_KEY_PREFIX.length + i * 2] = HEX_DIGITS[value >> 4];
            key[JOB_KEY_PREFIX.length + i * 2 + 1] = HEX_DIGITS[value & 0x0f];
        }
        return string(key);
    }

    /// @notice ENSv2 resolver resources for data keys are keccak256(bytes(key)).
    function jobResource(bytes32 jobId) public pure returns (uint256) {
        return uint256(keccak256(bytes(jobGrantKey(jobId))));
    }

    /// @notice Checks only the job-key resource; resolver-wide ROOT_RESOURCE grants do not count.
    /// @dev ENSv2 resolver permissions are scoped by setter argument, across names on this resolver.
    function hasWorkerGrant(bytes32 jobId, address worker) external view returns (bool) {
        if (jobId == bytes32(0) || worker == address(0)) return false;

        (bool ok, bytes memory result) = ensResolver.staticcall(
            abi.encodeCall(IENSScopedPermissionResolver.roles, (jobResource(jobId), worker))
        );
        if (!ok || result.length != 32) revert ResolverCallFailed();
        return (abi.decode(result, (uint256)) & ROLE_SET_DATA) != 0;
    }
}
