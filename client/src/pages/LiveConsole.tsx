import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, deserialise, type JobDetail, type JobSnapshot, type Operation, type ProtocolInfo, type RuntimeStatus } from "../lib/api/client";
import { asAddress, connectWallet, getWalletAccount, protocolDigest, signGatewayAction, type WalletAccount } from "../lib/api/wallet";

const ZERO_HEAD = `0x${"0".repeat(64)}` as const;
const digestPattern = /^0x[\da-f]{64}$/i;
const signaturePattern = /^0x[\da-f]{130}$/i;

type CheckpointBundle = {
  worker: string;
  epoch: number;
  manifestDigest: string;
  manifestRef: string;
  artifactManifestDigest: string;
  offerNonce: string;
  offerExpiry: number;
  offerSignature: string;
  workerAuth: { nonce: string; expiry: number; signature: string };
};

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) {
    return import.meta.env.PROD && !import.meta.env.VITE_API_URL
      ? "The production API URL is not configured. Set VITE_API_URL to the deployed BATON API origin."
      : "Could not reach the BATON API. Check that the API is running and VITE_API_URL points to it.";
  }
  if (error instanceof Error) return error.message;
  return "The request failed. Try again or refresh the API status.";
}

function humanize(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

function short(value: string, chars = 9): string {
  return value.length > chars * 2 + 3 ? `${value.slice(0, chars)}…${value.slice(-chars)}` : value;
}

function amount(value: bigint | undefined, asset = "") {
  return value === undefined ? "—" : `${value.toString()}${asset ? ` ${asset}` : ""}`;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}

function validDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) throw new Error(`${label} must be a 32-byte 0x digest.`);
  return value.toLowerCase();
}

function validSignature(value: unknown, label: string): string {
  if (typeof value !== "string" || !signaturePattern.test(value)) throw new Error(`${label} must be a 65-byte 0x signature.`);
  return value;
}

export function LiveConsole() {
  const [health, setHealth] = useState<{ status: string; service: string; timestamp: string } | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [protocol, setProtocol] = useState<ProtocolInfo | null>(null);
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [operationsNote, setOperationsNote] = useState("");
  const [wallet, setWallet] = useState<WalletAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [workerAddress, setWorkerAddress] = useState("");
  const [checkpointJson, setCheckpointJson] = useState("");
  const [takeoverAckJson, setTakeoverAckJson] = useState("");
  const [successorAddress, setSuccessorAddress] = useState("");
  const [compatibilityDigest, setCompatibilityDigest] = useState("");
  const [snapshotJson, setSnapshotJson] = useState("");
  const [serviceName, setServiceName] = useState("batch-data-v1");
  const [serviceAmount, setServiceAmount] = useState("1");
  const [quoteResult, setQuoteResult] = useState<{ approved: boolean; reason?: string; balance?: { available: bigint } } | null>(null);

  const refresh = useCallback(async (preferId: string | null = selectedId) => {
    setLoading(true);
    try {
      const [apiHealth, apiStatus, apiProtocol, apiJobs] = await Promise.all([
        api.health(), api.status(), api.protocol(), api.jobs(),
      ]);
      setHealth(apiHealth);
      setRuntime(apiStatus);
      setProtocol(apiProtocol);
      setJobs(apiJobs);
      const selected = preferId && apiJobs.some((job) => job.terms.jobId === preferId)
        ? preferId
        : apiJobs[0]?.terms.jobId ?? null;
      setSelectedId(selected);
      if (!selected) {
        setDetail(null);
        setOperations([]);
        setOperationsNote("");
        return;
      }
      const jobDetail = await api.job(selected);
      setDetail(jobDetail);
      if (jobDetail.operations) {
        setOperations(jobDetail.operations);
        setOperationsNote("");
      } else {
        try {
          setOperations(await api.operations(selected));
          setOperationsNote("");
        } catch (opsError) {
          setOperations([]);
          setOperationsNote(opsError instanceof ApiError && opsError.status === 503
            ? "Operation history is not available to this API role."
            : "Operation history could not be loaded.");
        }
      }
      setWorkerAddress(jobDetail.job.task.assignedWorker ?? "");
    } catch (loadError) {
      setError(errorText(loadError));
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh(null);
    const interval = window.setInterval(() => void refresh(), 12_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!window.ethereum) return;
    void getWalletAccount().then(setWallet).catch(() => setWallet(null));
  }, []);

  const job = detail?.job ?? null;
  const localFixture = protocol?.networkMode === "local-fixture";
  const nextMilestone = useMemo(() => job?.terms.task.milestones[job.task.nextMilestone], [job]);
  const canMutate = Boolean(localFixture || runtime?.configuration.sepoliaMutations);

  async function withBusy(label: string, task: () => Promise<string | void>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const preferredId = await task();
      setNotice(`${label} completed.`);
      await refresh(typeof preferredId === "string" ? preferredId : selectedId);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setBusy("");
    }
  }

  async function connect() {
    setError("");
    try {
      const account = await connectWallet(protocol?.networkMode === "testnet-configured" ? protocol.gatewayAuth?.chainId : undefined);
      setWallet(account);
      setNotice(`Wallet connected · ${short(account.address, 6)}`);
    } catch (walletError) {
      setError(errorText(walletError));
    }
  }

  async function authorize(jobSnapshot: JobSnapshot, action: string, payload: unknown, epoch = jobSnapshot.task.epoch) {
    if (localFixture) return {};
    if (!protocol) throw new Error("Protocol configuration is still loading.");
    if (!runtime?.configuration.sepoliaMutations) throw new Error("The API has no confirmed-chain mutation writer configured.");
    const account = wallet ?? await connectWallet(protocol.gatewayAuth?.chainId);
    setWallet(account);
    return signGatewayAction({ job: jobSnapshot, protocol, action, payload, epoch, account });
  }

  async function createFixture() {
    if (!localFixture || !import.meta.env.DEV) throw new Error("Local fixture job creation is disabled outside development mode.");
    await withBusy("Create local job", async () => {
      const created = await api.createLocalJob(wallet ? { buyer: wallet.address } : {});
      return created.terms.jobId;
    });
  }

  async function importSnapshot() {
    await withBusy("Import funded job", async () => {
      if (!protocol) throw new Error("Protocol configuration is still loading.");
      const snapshot = deserialise<JobSnapshot>(JSON.parse(snapshotJson));
      if (!snapshot?.terms?.buyer || !snapshot?.task?.acceptedHead) throw new Error("The JSON must be a BATON funded job snapshot.");
      const snapshotDigest = await protocolDigest(snapshot);
      const account = wallet ?? await connectWallet(protocol.gatewayAuth?.chainId);
      setWallet(account);
      const auth = await signGatewayAction({
        job: snapshot,
        protocol,
        action: "IMPORT_JOB",
        payload: { snapshotDigest },
        epoch: 0,
        account,
      });
      const imported = await api.importJob({ snapshot, ...auth });
      setSnapshotJson("");
      return imported.terms.jobId;
    });
  }

  async function assignWorker() {
    if (!job) return;
    await withBusy("Assign worker", async () => {
      const worker = asAddress(workerAddress).toLowerCase();
      const payload = { worker };
      const auth = await authorize(job, "ASSIGN_WORKER", payload);
      await api.assign(job.terms.jobId, { ...payload, ...auth });
    });
  }

  async function buyerAction(action: "pause" | "resume" | "drain" | "cancel-drain") {
    if (!job) return;
    const actions = { pause: "PAUSE_JOB", resume: "RESUME_JOB", drain: "DRAIN_TASK", "cancel-drain": "CANCEL_DRAIN" } as const;
    await withBusy(`${action.replace("-", " ")} job`, async () => {
      const auth = await authorize(job, actions[action], {});
      await api.action(job.terms.jobId, action, auth);
    });
  }

  async function acceptCheckpoint() {
    if (!job || !protocol) return;
    await withBusy("Accept checkpoint", async () => {
      const bundle = parseRecord(JSON.parse(checkpointJson)) as unknown as CheckpointBundle;
      const worker = asAddress(String(bundle.worker)).toLowerCase();
      const epoch = Number(bundle.epoch);
      if (epoch !== job.task.epoch) throw new Error("The worker offer epoch no longer matches this job. Refresh and request a new offer.");
      const manifestDigest = validDigest(bundle.manifestDigest, "Manifest digest");
      const artifactManifestDigest = validDigest(bundle.artifactManifestDigest, "Artifact manifest digest");
      const manifestRef = String(bundle.manifestRef ?? "").trim();
      if (!manifestRef) throw new Error("The checkpoint offer needs a durable manifest locator.");
      if (!nextMilestone) throw new Error("This job has no milestone left to accept.");
      const expectedHead = job.task.acceptedHead.manifestDigest;
      const sequence = job.task.acceptedHead.sequence + 1;
      const previousAcceptedHead = expectedHead.toLowerCase() === ZERO_HEAD ? null : expectedHead;
      const candidate = {
        taskId: job.task.taskId,
        worker,
        epoch,
        acceptanceSpecHash: nextMilestone.acceptanceSpecHash,
        expectedHead,
        newHead: {
          manifestDigest,
          manifestRef,
          artifactManifestDigest,
          schemaVersion: "checkpoint.v1",
          sequence,
          previousAcceptedHead,
        },
      };

      let workerAuth: Record<string, unknown> = {};
      let authorizedPayload: Record<string, unknown> = candidate;
      let offerFields: Record<string, unknown> = {};
      if (!localFixture) {
        const workerAuthNonce = validDigest(bundle.workerAuth?.nonce, "Worker authorization nonce");
        const workerAuthSignature = validSignature(bundle.workerAuth?.signature, "Worker authorization signature");
        const workerAuthExpiry = Number(bundle.workerAuth?.expiry);
        const offerSignature = validSignature(bundle.offerSignature, "Milestone offer signature");
        const offerNonce = BigInt(bundle.offerNonce);
        const offerExpiry = BigInt(bundle.offerExpiry);
        if (!Number.isSafeInteger(workerAuthExpiry) || workerAuthExpiry <= Date.now() / 1000) throw new Error("The worker authorization has expired.");
        if (!job.chainJobId || !job.chainTaskId) throw new Error("This job is missing its on-chain identifier binding.");
        const offer = {
          jobId: job.chainJobId,
          taskId: job.chainTaskId,
          termsHash: job.terms.termsHash,
          producer: worker,
          epoch: BigInt(epoch),
          milestone: job.task.nextMilestone,
          acceptanceSpecHash: nextMilestone.acceptanceSpecHash,
          expectedHead,
          newHead: manifestDigest,
          manifestRef,
          sequence: BigInt(sequence),
          nonce: offerNonce,
          expiry: offerExpiry,
        };
        authorizedPayload = { ...candidate, contractOffer: { ...offer, signature: offerSignature } };
        workerAuth = {
          workerAuthNonce,
          workerAuthExpiry,
          workerAuthSignature,
        };
        offerFields = {
          offerNonce: offerNonce.toString(),
          offerExpiry: offerExpiry.toString(),
          offerSignature,
        };
      }
      const buyerSignature = await authorize(job, "MILESTONE_ACCEPT", authorizedPayload, epoch) as {
        authNonce?: string;
        authExpiry?: string;
        authSignature?: string;
      };
      const buyerAuth = {
        buyerAuthNonce: buyerSignature.authNonce,
        buyerAuthExpiry: buyerSignature.authExpiry,
        buyerAuthSignature: buyerSignature.authSignature,
      };
      await api.acceptCheckpoint(job.terms.jobId, { ...candidate, ...candidate.newHead, ...offerFields, ...workerAuth, ...buyerAuth });
      setCheckpointJson("");
    });
  }

  async function drainForTakeover() {
    if (!runtime?.configuration.takeoverPolicyEnabled && !localFixture) {
      setError("The API takeover policy is not enabled. It must drain safely and reconcile pending paid work before authority moves.");
      return;
    }
    await buyerAction("drain");
  }

  async function submitTakeoverAck() {
    if (!job) return;
    await withBusy("Submit successor acknowledgement", async () => {
      if (!runtime?.configuration.takeoverPolicyEnabled) throw new Error("The API takeover policy is not enabled.");
      const acknowledgement = parseRecord(JSON.parse(takeoverAckJson));
      await api.takeoverAck(job.terms.jobId, acknowledgement);
      setTakeoverAckJson("");
    });
  }

  async function takeoverLocal() {
    if (!job || !localFixture) return;
    await withBusy("Take over job", async () => {
      const successor = asAddress(successorAddress).toLowerCase();
      const compatibilityReport = validDigest(compatibilityDigest, "Compatibility report digest");
      const payload = {
        successor,
        expectedHead: job.task.acceptedHead.manifestDigest,
        expectedEpoch: job.task.epoch,
        compatibilityReport,
      };
      const auth = await authorize(job, "TAKEOVER_TASK", payload, job.task.epoch);
      await api.takeover(job.terms.jobId, { ...payload, ...auth });
    });
  }

  async function requestQuote() {
    if (!job) return;
    setError("");
    setQuoteResult(null);
    try {
      setQuoteResult(await api.quote(job.terms.jobId, serviceName, serviceAmount));
    } catch (quoteError) {
      setError(errorText(quoteError));
    }
  }

  return (
    <div className="console api-console">
      <header className="console-intro api-intro">
        <div>
          <p className="eyebrow"><span className="hero-signal" aria-hidden="true" />Buyer workspace · API backed</p>
          <h1>Job operations</h1>
          <p>Read the configured BATON API and authorize buyer actions from your wallet. Worker signatures and verified checkpoint artifacts remain with the worker.</p>
        </div>
        <div className="api-intro-actions">
          <button className="btn btn-ghost" type="button" onClick={() => void connect()}>{wallet ? `Wallet · ${short(wallet.address, 5)}` : "Connect wallet"}</button>
          <Link className="btn btn-primary" to="/demo">Run browser demo <span aria-hidden="true">↗</span></Link>
        </div>
      </header>

      <section className="api-health" aria-label="Backend status">
        <div className={`api-health-main${health ? " is-online" : " is-offline"}`}>
          <i /> <b>{health ? "API online" : loading ? "Connecting" : "API unavailable"}</b>
          <span>{health ? health.service : "No response"}</span>
        </div>
        <div><small>MODE</small><b>{protocol ? humanize(protocol.networkMode) : "—"}</b></div>
        <div><small>CONTENT STORE</small><b>{runtime?.contentStore ?? "—"}</b></div>
        <div><small>PAYMENTS</small><b>{runtime?.paymentProvider ?? "—"}</b></div>
        <div><small>CHAIN WRITES</small><b>{runtime?.configuration.sepoliaMutations ? "enabled" : "unavailable"}</b></div>
        <button className="api-refresh" type="button" disabled={loading} onClick={() => void refresh(selectedId)} aria-label="Refresh API data">↻</button>
      </section>

      {(error || notice) && <div className={`api-feedback${error ? " is-error" : " is-success"}`} role={error ? "alert" : "status"}>{error || notice}<button type="button" onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss message">×</button></div>}

      {runtime && (!runtime.configuration.arkiv || !runtime.configuration.hederaX402 || !runtime.configuration.sepoliaMutations) && (
        <div className="api-readiness" role="status">
          <b>Some live integrations are not configured.</b>
          <span>
            {[
              !runtime.configuration.arkiv && "Arkiv storage",
              !runtime.configuration.hederaX402 && "Hedera x402 payments",
              !runtime.configuration.sepoliaMutations && "confirmed Sepolia writes",
            ].filter(Boolean).join(" · ")} may be unavailable. API-reported flags reflect configuration, not a live transaction proof.
          </span>
        </div>
      )}

      <div className="api-workspace">
        <aside className="api-jobs panel">
          <div className="panel-title"><h3>Jobs</h3><span className="mono small muted">{jobs.length} found</span></div>
          <div className="api-job-list" aria-label="API jobs">
            {jobs.map((item) => (
              <button key={item.terms.jobId} type="button" className={`api-job-item${selectedId === item.terms.jobId ? " is-selected" : ""}`} onClick={() => { setSelectedId(item.terms.jobId); void refresh(item.terms.jobId); }}>
                <span><b>{item.terms.jobId}</b><small>{item.task.status} · epoch {item.task.epoch}</small></span>
                <i aria-hidden="true">→</i>
              </button>
            ))}
            {!jobs.length && <p className="api-empty">No jobs are registered in this API yet.</p>}
          </div>

          {protocol?.networkMode === "local-fixture" && import.meta.env.DEV && (
            <button className="btn btn-primary btn-block" type="button" disabled={Boolean(busy)} onClick={() => void createFixture()}>{busy === "Create local job" ? "Creating…" : "Create local test job"}</button>
          )}

          {protocol?.networkMode === "testnet-configured" && (
          <details className="api-import">
            <summary>{protocol?.networkMode === "testnet-configured" ? "Import funded chain job" : "Import a job snapshot"}</summary>
            <p>Import requires a pristine funded escrow snapshot and a signature from its buyer wallet. This does not create or fund an on-chain job.</p>
            <textarea value={snapshotJson} onChange={(event) => setSnapshotJson(event.target.value)} rows={7} spellCheck={false} placeholder="Paste the serialized BATON job snapshot JSON" aria-label="Funded job snapshot JSON" />
            <button className="btn btn-ghost btn-sm" type="button" disabled={Boolean(busy) || !snapshotJson.trim()} onClick={() => void importSnapshot()}>{busy === "Import funded job" ? "Signing and importing…" : "Sign and import"}</button>
          </details>
          )}
          <p className="api-last-sync">{health ? `API checked ${new Date(health.timestamp).toLocaleTimeString()}` : "Waiting for API"}</p>
        </aside>

        <main className="api-detail-column">
          {!job && (
            <section className="api-empty-state panel">
              <span className="api-empty-mark" aria-hidden="true">B</span>
              <p className="eyebrow">Live API data</p>
              <h2>{loading ? "Loading jobs" : health ? "No jobs yet." : "Waiting for the API."}</h2>
              <p>{health
                ? protocol?.networkMode === "testnet-configured"
                  ? "Import a buyer-funded escrow job snapshot to begin managing a real job here. The browser demo remains available separately."
                  : "Create a local test job to exercise persisted API operations. It does not write to a chain or spend funds."
                : "Start the BATON API or configure VITE_API_URL to load real backend state."}</p>
              {!health && <button className="btn btn-ghost" type="button" onClick={() => void refresh(null)}>Retry connection</button>}
            </section>
          )}

          {job && (
            <>
              <section className="api-job-summary panel">
                <div className="api-job-heading">
                  <div>
                    <p className="eyebrow">Registered job</p>
                    <h2>{job.terms.jobId}</h2>
                    <p className="api-job-subtitle">Buyer {short(job.terms.buyer, 8)} · updated {new Date(job.updatedAt).toLocaleString()}</p>
                  </div>
                  <span className={`api-status-tag status-${job.task.status.toLowerCase()}`}><i />{humanize(job.task.status)}</span>
                </div>
                <div className="api-metrics">
                  <div><small>WORKER</small><b>{job.task.assignedWorker ? short(job.task.assignedWorker, 8) : "Unassigned"}</b></div>
                  <div><small>EPOCH</small><b>{job.task.epoch}</b></div>
                  <div><small>NEXT MILESTONE</small><b>{nextMilestone?.id ?? "Complete"}</b></div>
                  <div><small>ACCEPTED HEAD</small><b title={job.task.acceptedHead.manifestDigest}>{short(job.task.acceptedHead.manifestDigest, 8)}</b></div>
                </div>
                <div className="api-job-foot">
                  <span>Task <code>{job.task.taskId}</code></span>
                  <span>{job.task.drained ? "Admissions drained" : "Admissions open"}</span>
                  {job.chainJobId && <span>Chain job <code>{short(job.chainJobId, 8)}</code></span>}
                </div>
              </section>

              <section className="api-operation-grid">
                <div className="panel api-controls">
                  <div className="panel-title"><h3>Buyer actions</h3><span className="mono small muted">{localFixture ? "LOCAL FIXTURE" : "WALLET SIGNED"}</span></div>
                  {!canMutate && <p className="api-callout">Confirmed chain mutations are not enabled in the API configuration.</p>}
                  {!localFixture && wallet && wallet.address.toLowerCase() !== job.terms.buyer.toLowerCase() && <p className="api-callout is-warning">Connect the job buyer account {short(job.terms.buyer, 7)} to authorize changes.</p>}
                  {!job.task.assignedWorker && job.task.status === "FUNDED" && (
                    <div className="api-action-form">
                      <label>Worker wallet address<input value={workerAddress} onChange={(event) => setWorkerAddress(event.target.value)} placeholder="0x…" autoCapitalize="none" spellCheck={false} /></label>
                      <button className="btn btn-primary btn-sm" type="button" disabled={Boolean(busy) || !canMutate || !workerAddress.trim()} onClick={() => void assignWorker()}>{busy === "Assign worker" ? "Signing…" : "Assign worker"}</button>
                    </div>
                  )}
                  <div className="api-action-buttons">
                    {job.task.status === "FUNDED" && job.task.assignedWorker && <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !canMutate} onClick={() => void buyerAction("pause")}>Pause job</button>}
                    {job.task.status === "PAUSED" && <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !canMutate} onClick={() => void buyerAction("resume")}>Resume job</button>}
                    {job.task.assignedWorker && !job.task.drained && !["COMPLETED", "CLOSED"].includes(job.task.status) && (localFixture || runtime?.configuration.takeoverPolicyEnabled) && (
                      <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !canMutate} onClick={() => void drainForTakeover()}>Drain before recovery</button>
                    )}
                  {job.task.drained && runtime?.configuration.takeoverPolicyEnabled && (
                      <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !canMutate} onClick={() => void buyerAction("cancel-drain")}>Cancel drain</button>
                    )}
                  </div>
                  {!localFixture && !runtime?.configuration.takeoverPolicyEnabled && job.task.assignedWorker && <p className="api-caption">Pause and resume are buyer controlled. A handoff drain is hidden until the API takeover policy is enabled.</p>}
                  {localFixture && job.task.drained && (
                    <div className="api-action-form api-takeover-form">
                      <label>Successor wallet address<input value={successorAddress} onChange={(event) => setSuccessorAddress(event.target.value)} placeholder="0x…" autoCapitalize="none" spellCheck={false} /></label>
                      <label>Compatibility report digest<input value={compatibilityDigest} onChange={(event) => setCompatibilityDigest(event.target.value)} placeholder="0x + 64 hex characters" spellCheck={false} /></label>
                      <button className="btn btn-primary btn-sm" type="button" disabled={Boolean(busy) || !successorAddress.trim() || !compatibilityDigest.trim()} onClick={() => void takeoverLocal()}>Take over in local fixture</button>
                    </div>
                  )}
                  {runtime?.configuration.takeoverPolicyEnabled && job.task.drained && (
                    <details className="api-worker-bundle">
                      <summary>Submit Worker B recovery acknowledgement</summary>
                      <p>Worker B should paste the signed acknowledgement produced after it verified the accepted checkpoint.</p>
                      <textarea value={takeoverAckJson} onChange={(event) => setTakeoverAckJson(event.target.value)} rows={6} spellCheck={false} placeholder="Paste the JSON acknowledgement signed by Worker B" aria-label="Worker B signed recovery acknowledgement" />
                      <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !takeoverAckJson.trim()} onClick={() => void submitTakeoverAck()} type="button">Submit worker acknowledgement</button>
                    </details>
                  )}
                </div>

                {nextMilestone && job.task.assignedWorker && job.task.status === "FUNDED" && (
                  <div className="panel api-checkpoint-panel">
                    <div className="panel-title"><h3>Checkpoint offer</h3><span className="mono small muted">{nextMilestone.id}</span></div>
                    <p>Accept the exact artifacts proposed by the assigned worker. In chain mode, paste the worker-authenticated offer bundle; the buyer wallet signs acceptance below.</p>
                    <details className="api-worker-bundle">
                      <summary>Offer bundle fields</summary>
                      <pre>{`{
  "worker": "0x…",
  "epoch": ${job.task.epoch},
  "manifestDigest": "0x…",
  "manifestRef": "arkiv://…",
  "artifactManifestDigest": "0x…",
  "offerNonce": "1",
  "offerExpiry": <future UNIX timestamp in seconds>,
  "offerSignature": "0x…",
  "workerAuth": { "nonce": "0x…", "expiry": <future UNIX timestamp in seconds>, "signature": "0x…" }
}`}</pre>
                    </details>
                    <textarea value={checkpointJson} onChange={(event) => setCheckpointJson(event.target.value)} rows={7} spellCheck={false} placeholder="Paste the worker's signed checkpoint offer JSON" aria-label="Worker checkpoint offer JSON" />
                    <button className="btn btn-primary btn-sm" type="button" disabled={Boolean(busy) || !canMutate || !checkpointJson.trim()} onClick={() => void acceptCheckpoint()}>{busy === "Accept checkpoint" ? "Signing acceptance…" : "Review and accept checkpoint"}</button>
                  </div>
                )}
              </section>

              <section className="api-data-grid">
                <div className="panel api-credits">
                  <div className="panel-title"><h3>Reward credits</h3><span className="mono small muted">{job.credits.length} accepted</span></div>
                  {job.credits.length ? <ul>{job.credits.map((credit) => <li key={credit.id}><span>{credit.milestoneId}<small>{short(credit.worker, 7)}</small></span><b>{amount(credit.amount, "credits")}</b><i>{credit.claimed ? "claimed" : "available"}</i></li>)}</ul> : <p className="api-empty">Accepted work will create credits here.</p>}
                  <div className="api-balance"><span>Service budget</span><b>{amount(job.terms.serviceBudget, job.terms.serviceAsset)}</b><small>Provider · {job.servicePolicy.providerId}</small></div>
                  {detail?.balance && <div className="api-balance"><span>Available for services</span><b>{amount(detail.balance.available, job.servicePolicy.asset)}</b><small>Reserved {amount(detail.balance.reserved, job.servicePolicy.asset)} · spent {amount(detail.balance.settledSpend, job.servicePolicy.asset)}</small></div>}
                </div>

                <div className="panel api-services">
                  <div className="panel-title"><h3>Service budget check</h3><span className="mono small muted">QUOTE</span></div>
                  <div className="api-quote-form">
                    <label>Approved service<input value={serviceName} onChange={(event) => setServiceName(event.target.value)} list="api-approved-services" /><datalist id="api-approved-services">{job.servicePolicy.approvedServices.map((name) => <option key={name} value={name} />)}</datalist></label>
                    <label>Amount<input value={serviceAmount} onChange={(event) => setServiceAmount(event.target.value)} inputMode="decimal" /></label>
                    <button className="btn btn-ghost btn-sm" onClick={() => void requestQuote()} type="button">Check budget</button>
                  </div>
                  {quoteResult && <p className={`api-quote-result${quoteResult.approved ? " is-approved" : " is-denied"}`}>{quoteResult.approved ? "Approved by the current policy" : humanize(quoteResult.reason ?? "not approved")}{quoteResult.balance && ` · ${amount(quoteResult.balance.available, job.servicePolicy.asset)} available`}</p>}
                  <div className="api-operation-list">
                    <div className="api-subhead"><b>Recent operations</b><button type="button" onClick={() => void refresh(selectedId)}>Refresh</button></div>
                    {operations.length ? operations.slice(0, 5).map((operation) => (
                      <div className="api-operation" key={operation.operationId}><span><b>{operation.service}</b><small>{short(operation.operationId, 8)}</small></span><span>{operation.state}</span><b>{amount(operation.amount, operation.asset)}</b></div>
                    )) : <p className="api-caption">{operationsNote || "No service operations recorded."}</p>}
                  </div>
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
