import { readFile } from "node:fs/promises";
import { recoverTypedDataAddress } from "viem";
import { hashOffer, OFFER_TYPES } from "../server/dist/src/chain/signing.js";

const vector = JSON.parse(await readFile(new URL("../server/src/chain/signing-vector.json", import.meta.url), "utf8"));
const offer = { ...vector.offer, epoch: BigInt(vector.offer.epoch), nonce: BigInt(vector.offer.nonce), expiry: BigInt(vector.offer.expiry) };
const hash = hashOffer(offer, vector.domain.chainId, vector.domain.verifyingContract);
if (hash !== vector.typedDataHash) throw new Error(`hash mismatch: ${hash}`);
const recovered = await recoverTypedDataAddress({ domain: vector.domain, types: OFFER_TYPES, primaryType: "MilestoneOffer", message: offer, signature: vector.signature });
if (recovered.toLowerCase() !== vector.offer.producer.toLowerCase()) throw new Error(`recovered ${recovered}, expected ${vector.offer.producer}`);
console.log(JSON.stringify({ vector: "milestone-offer", hash, recovered, match: true }));
