# Contracts

`JobEscrow.sol` implements the fixed-price, per-task authority boundary: buyer-funded exact-transfer ERC-20 rewards, EIP-712 milestone offers and takeover acknowledgements, per-task epoch/head checks, drain/pause/close boundaries, immutable worker credits, and post-closure claims. `JobAuthority.sol` accepts only an explicit resolver permission function (`isAuthorized(bytes32,address)`); it never treats ENS text records as authority.

Build locally with:

```sh
forge build
```

The contract uses Solidity `0.8.28`, OpenZeppelin 5.x and the EIP-712 domain `BATON Job Escrow / 1`. The generated ABI is intentionally deployment-specific and must be produced from the exact compiled commit before a Sepolia deployment. Until a local compiler or Foundry download is available, the source remains `BUILDING`; no live address is claimed.

`npm run contracts:compile` uses the pinned `solc` package, writes reproducible tracked ABIs to `server/contracts/abi/`, and writes ignored bytecode artifacts to `server/contracts/out/`. This is the repository's compiler-independent ABI generation path when Foundry's native solc cache is unavailable.
