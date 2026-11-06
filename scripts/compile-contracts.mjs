import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import solc from "solc";

const solcVersion = solc.version();
if (!solcVersion.startsWith("0.8.28+commit.7893614a.")) {
  throw new Error(`PINNED_SOLC_VERSION_REQUIRED: expected 0.8.28+commit.7893614a, loaded ${solcVersion}`);
}

const root = resolve(new URL("..", import.meta.url).pathname);
const contractsRoot = resolve(root, "server/contracts");
const sources = {};
for (const name of ["BatonTestToken.sol", "JobAuthority.sol", "JobEscrow.sol"]) {
  sources[`src/${name}`] = { content: await readFile(resolve(contractsRoot, "src", name), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input), {
  import: (path) => {
    try { return { contents: requireSource(path) }; }
    catch { return { error: `Unable to resolve ${path}` }; }
  },
}));
const errors = (output.errors ?? []).filter((error) => error.severity === "error");
if (errors.length > 0) {
  console.error(errors.map((error) => error.formattedMessage).join("\n"));
  process.exit(1);
}
const out = resolve(root, "server/contracts/out");
const abiDir = resolve(root, "server/contracts/abi");
await mkdir(out, { recursive: true });
await mkdir(abiDir, { recursive: true });
for (const [sourceName, contracts] of Object.entries(output.contracts ?? {})) {
  for (const [contractName, artifact] of Object.entries(contracts)) {
    const target = resolve(out, contractName);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(`${target}.abi.json`, JSON.stringify(artifact.abi, null, 2));
    if (["BatonTestToken", "JobEscrow", "JobAuthority"].includes(contractName)) {
      await writeFile(resolve(abiDir, `${contractName}.json`), JSON.stringify(artifact.abi, null, 2));
    }
    await writeFile(`${target}.bin`, artifact.evm.bytecode.object);
    console.log(`${sourceName}:${contractName} ABI=${artifact.abi.length} bytecodeBytes=${artifact.evm.bytecode.object.length / 2}`);
  }
}

function requireSource(path) {
  if (path.startsWith("@openzeppelin/")) return readSync(resolve(root, "node_modules", path));
  return readSync(resolve(contractsRoot, path));
}

function readSync(path) {
  return readFileSync(path, "utf8");
}
