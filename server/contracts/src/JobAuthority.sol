// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Narrow adapter for a deployed, job-scoped authority resolver.
/// The resolver must expose an explicit permission query; text records are never accepted.
interface IJobPermissionResolver {
    function isAuthorized(bytes32 jobId, address worker) external view returns (bool);
}

contract JobAuthority {
    error ResolverUnset();
    error ResolverCallFailed();

    address public immutable resolver;

    constructor(address resolver_) {
        if (resolver_ == address(0)) revert ResolverUnset();
        resolver = resolver_;
    }

    function hasWorkerGrant(bytes32 jobId, address worker) external view returns (bool) {
        (bool ok, bytes memory result) = resolver.staticcall(
            abi.encodeCall(IJobPermissionResolver.isAuthorized, (jobId, worker))
        );
        if (!ok || result.length != 32) revert ResolverCallFailed();
        return abi.decode(result, (bool));
    }
}
