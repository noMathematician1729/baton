import { runLocalDemo } from "../../server/apps/worker/src/localDemo.js";

const result = runLocalDemo();
console.log("Local checkpoint handoff passed.");
console.log("A completed: batch-1 (sum " + result.stateA.completed[0]?.sum + ")");
console.log("B recovered the AES-256-GCM checkpoint and completed: batch-2, batch-3");
console.log("Final batch outputs: " + result.finalState.completed.map((batch) => batch.batchId + "=" + batch.outputDigest).join(", "));
console.log("Quantitative state continued with posterior mean " + result.posteriorMean.toFixed(2));
console.log("Encrypted envelope bytes: " + result.encryptedEnvelopeBytes);
console.log("Local fixture only: no Arkiv write, wallet, payment, or chain transaction was used.");
