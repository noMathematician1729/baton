# Contracts

`JobEscrow.sol` implements the fixed-price, per-task authority boundary: buyer-funded exact-transfer ERC-20 rewards, EIP-712 milestone offers and takeover acknowledgements, per-task epoch/head checks, drain/pause/close boundaries, immutable worker credits, and post-closure claims. `JobAuthority.sol` adapts the deployed ENSv2 Permissioned Resolver's Enhanced Access Control interface. It checks `roles(resource, worker)` for `ROLE_SET_DATA` on the job's `baton.job.v1:<lowercase-job-id>` data key. The adapter deliberately reads that key's resource directly, so a resolver-wide root role cannot silently authorize every BATON job.

Keep the two deployed addresses distinct in local configuration: `ENS_RESOLVER_ADDRESS` is the real resolver for `ENS_JOB_NAME`; `BATON_AUTHORITY_ADAPTER_ADDRESS` is the BATON `JobAuthority` contract that stores and queries that resolver address. Grant a worker's job permission on the ENS resolver with `grantSetterRoles(setDataSetter, worker)` and revoke it with `revokeRoles(jobResource, ROLE_SET_DATA, worker)`.

ENSv2 scopes resolver roles by setter argument across names served by that resolver, not by ENS name. BATON gives each job a unique data key, ignores `ROOT_RESOURCE` grants, and uses the resolver instance returned for the configured ENS name.

Build locally with:

```sh
forge build
```

The contracts use Solidity `0.8.28`, OpenZeppelin 5.x and the EIP-712 domain `BATON Job Escrow / 1`. Generated ABIs are deployment-specific and must be produced from the exact compiled commit before deployment. The adapter follows the ENSv2 [Permissioned Resolver](https://docs.ens.domains/ensv2/permissioned-resolver/) and [Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/) resource and role rules.

`npm run contracts:compile` uses the pinned `solc` package, writes reproducible tracked ABIs to `server/contracts/abi/`, and writes ignored bytecode artifacts to `server/contracts/out/`. This is the repository's compiler-independent ABI generation path when Foundry's native solc cache is unavailable.

After configuring `ENS_JOB_NAME`, `SEPOLIA_RPC_URL`, and `SEPOLIA_DEPLOYER_PRIVATE_KEY` in the ignored local `.env`, run `npm run test:sepolia:authority`. The command resolves the name on Sepolia, checks that the signer can administer the resolver, deploys the adapter if no adapter address is configured, then performs a temporary scoped grant/revoke and wrong-job check. It writes the real resolver and adapter addresses to their separate `.env` fields only after all live assertions pass. It never prints the private key.
