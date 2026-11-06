import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rawUrl = process.argv[2];
if (!rawUrl) throw new Error("Usage: npm run key-service:set-url -- https://<temporary-tunnel-host>");
const endpoint = new URL(rawUrl);
if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  throw new Error("The key-service tunnel URL must be a clean HTTPS origin");
}
endpoint.pathname = "/v1/resolve";
const serviceUrl = endpoint.toString();
for (const relativePath of [".env", ".env.key-service", ".env.worker-a", ".env.worker-b"]) {
  const path = join(root, relativePath);
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  await writeEnvValue(path, "CHECKPOINT_KEY_SERVICE_URL", serviceUrl);
}
process.stdout.write(JSON.stringify({ result: "url-configured", endpoint: serviceUrl, filesUpdated: [".env", ".env.key-service", ".env.worker-a", ".env.worker-b"], secretValuesPrinted: false }) + "\n");

async function writeEnvValue(path, name, value) {
  let content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/);
  const prefix = `${name}=`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index >= 0) lines[index] = prefix + value;
  else lines.push(prefix + value);
  while (lines.length && lines.at(-1) === "") lines.pop();
  const temporary = `${path}.tmp`;
  await writeFile(temporary, lines.join("\n") + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}
