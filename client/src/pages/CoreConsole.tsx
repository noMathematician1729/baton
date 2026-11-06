import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getCoreJob,
  getCoreOverview,
  getCoreReconciliation,
  postCoreAction,
  type CoreJob,
  type CoreJobSummary,
  type CoreReconciliation,
  type CoreWorker,
} from "../lib/api/core";
import { SignalField } from "../components/SignalField";

const ELIGIBLE = (worker: CoreWorker) => worker.alive
  && worker.connection === "available"
  && worker.smoke?.passed === true;

export function CoreConsole() {
  const [workers, setWorkers] = useState<CoreWorker[]>([]);
  const [jobs, setJobs] = useState<CoreJobSummary[]>([]);
  const [job, setJob] = useState<CoreJob | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [buyerToken, setBuyerToken] = useState("");
  const [preferredWorker, setPreferredWorker] = useState("");
  const [takeoverWorker, setTakeoverWorker] = useState("");
  const [rewards, setRewards] = useState([3, 3, 4]);
  const [reconciliation, setReconciliation] = useState<CoreReconciliation | null>(null);
  const [apiError, setApiError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (preferredJobId?: string, signal?: AbortSignal) => {
    try {
      const overview = await getCoreOverview(signal);
      const nextJobId = (preferredJobId ?? selectedJobId)
        && overview.jobs.some((item) => item.jobId === (preferredJobId ?? selectedJobId))
        ? preferredJobId ?? selectedJobId
        : overview.jobs[0]?.jobId;
      const detail = nextJobId ? await getCoreJob(nextJobId, signal) : null;
      if (signal?.aborted) return;
      setWorkers(overview.workers);
      setJobs(overview.jobs);
      setSelectedJobId(nextJobId);
      setJob(detail);
      setApiError("");
    } catch (error) {
      if (!signal?.aborted) setApiError(error instanceof Error ? error.message : "Could not reach the BATON core API.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [selectedJobId]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = async () => {
      await refresh(undefined, controller.signal);
      if (!stopped) timer = window.setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    setReconciliation(null);
    setTakeoverWorker("");
  }, [selectedJobId]);

  const eligibleWorkers = useMemo(() => workers.filter(ELIGIBLE), [workers]);
  const alternateWorkers = useMemo(
    () => eligibleWorkers.filter((worker) => worker.workerId !== job?.activeWorkerId),
    [eligibleWorkers, job?.activeWorkerId],
  );

  async function runAction(key: string, action: () => Promise<string | void>, success: string) {
    if (!buyerToken.trim()) {
      setActionError("Enter the buyer API token to use operator controls.");
      return;
    }
    setPending(key);
    setActionError("");
    setNotice("");
    try {
      const preferredJobId = (await action()) || undefined;
      setNotice(success);
      await refresh(preferredJobId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The requested action failed.");
    } finally {
      setPending("");
    }
  }

  async function reconcile() {
    if (!job) return;
    setPending("reconcile");
    setActionError("");
    setNotice("");
    try {
      setReconciliation(await getCoreReconciliation(job.jobId));
      setNotice("On-chain accounting refreshed.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not reconcile this job.");
    } finally {
      setPending("");
    }
  }

  function createJob() {
    if (!eligibleWorkers.length) return;
    if (!rewards.every((value) => Number.isSafeInteger(value) && value > 0)) {
      setActionError("Enter a positive whole-token reward for each milestone.");
      return;
    }
    if (!window.confirm(`Create and fund a Sepolia job with ${rewards.join(" / ")} test tokens? This uses the configured buyer signer.`)) return;
    void runAction("create-job", async () => {
      const result = await postCoreAction<{ jobId: string }>("/core/jobs", buyerToken.trim(), {
        rewards,
        ...(preferredWorker ? { workerId: preferredWorker } : {}),
      });
      return result.jobId;
    }, "Job submitted. Provisioning will continue in the buyer API.");
  }

  function acceptMilestone(milestone: number, rewardTokens: number) {
    if (!job) return;
    if (!window.confirm(`Accept milestone ${milestone} and submit its ${rewardTokens}-token escrow transaction?`)) return;
    void runAction(`accept-${milestone}`, async () => {
      await postCoreAction(`/core/jobs/${job.jobId}/milestones/${milestone}/accept`, buyerToken.trim());
    }, `Milestone ${milestone} approved.`);
  }

  function requestTakeover() {
    if (!job) return;
    const target = takeoverWorker || alternateWorkers[0]?.workerId;
    if (!window.confirm(`Request a Sepolia worker takeover${target ? ` to ${target}` : ""}?`)) return;
    void runAction("takeover", async () => {
      await postCoreAction(`/core/jobs/${job.jobId}/takeover`, buyerToken.trim(), target ? { workerId: target } : {});
    }, "Takeover requested. The selected worker must acknowledge and recover the accepted head.");
  }

  return (
    <div className="core-page">
      <div className="core-shell">
        <header className="core-heading">
          <SignalField className="signal-core" />
          <div>
            <p className="eyebrow">Buyer operations</p>
            <h1>Live core console</h1>
            <p className="core-lede">Connected to the BATON buyer API. Worker, job, and checkpoint state refreshes every five seconds.</p>
          </div>
          <div className="core-heading-actions">
            <span className={`core-api-state ${apiError ? "is-offline" : loading ? "is-loading" : "is-online"}`}>
              <i />{apiError ? "Core unavailable" : loading ? "Connecting" : "API connected"}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={pending === "refresh"}>Refresh</button>
            <Link className="btn btn-ghost btn-sm" to="/demo">Browser demo</Link>
          </div>
        </header>

        <section className="core-access" aria-label="Buyer operator access">
          <div>
            <h2>Buyer controls</h2>
            <p>Enter the buyer API token from the buyer host’s private `.env`. It stays in this tab’s memory.</p>
          </div>
          <label className="core-token-field">
            <span>Buyer API token</span>
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={buyerToken}
              onChange={(event) => setBuyerToken(event.target.value)}
              placeholder="Enter token to enable controls"
              aria-label="Buyer API token"
            />
          </label>
        </section>

        {apiError && (
          <div className="core-alert" role="alert">
            <b>Live core API is unavailable.</b>
            <span>{apiError}</span>
            <p>Enable `BATON_CORE_ENABLED=true`, configure the buyer core values, then restart the API. The browser simulation is available separately.</p>
          </div>
        )}
        {actionError && <div className="core-alert core-alert-action" role="alert">{actionError}</div>}
        {notice && <div className="core-notice" role="status">{notice}</div>}

        <div className="core-layout">
          <aside className="core-sidebar">
            <section className="core-panel">
              <div className="core-panel-heading">
                <div><p className="eyebrow">Connected runtime</p><h2>Workers <span>{workers.length}</span></h2></div>
              </div>
              {workers.length === 0 ? (
                <p className="core-empty">No registered workers yet. Register a worker wallet, then connect its Codex runtime here.</p>
              ) : (
                <ul className="core-worker-list">
                  {workers.map((worker) => (
                    <WorkerRow
                      key={worker.workerId}
                      worker={worker}
                      tokenReady={Boolean(buyerToken.trim())}
                      pending={pending}
                      onConnect={() => void runAction(`connect-${worker.workerId}`, async () => {
                        await postCoreAction(`/core/workers/${encodeURIComponent(worker.workerId)}/connect`, buyerToken.trim());
                      }, `Worker ${worker.workerId} runtime started.`)}
                      onStop={() => {
                        if (!window.confirm(`Stop the ${worker.workerId} runtime process? Its job state will be preserved.`)) return;
                        void runAction(`stop-${worker.workerId}`, async () => {
                          await postCoreAction(`/core/workers/${encodeURIComponent(worker.workerId)}/stop`, buyerToken.trim(), { mode: "kill" });
                        }, `Worker ${worker.workerId} stopped.`);
                      }}
                    />
                  ))}
                </ul>
              )}
              <p className="core-footnote">Eligible for new work: available, live process, and smoke test passed.</p>
            </section>

            <section className="core-panel core-create-panel">
              <div className="core-panel-heading">
                <div><p className="eyebrow">Sepolia lifecycle</p><h2>New job</h2></div>
              </div>
              <p className="core-muted">Incident triage with three buyer-approved milestones.</p>
              <label className="core-field">
                <span>Initial worker</span>
                <select value={preferredWorker} onChange={(event) => setPreferredWorker(event.target.value)}>
                  <option value="">Auto-select eligible worker</option>
                  {eligibleWorkers.map((worker) => <option key={worker.workerId} value={worker.workerId}>{worker.workerId} · {short(worker.address)}</option>)}
                </select>
              </label>
              <div className="core-reward-fields">
                {rewards.map((reward, index) => (
                  <label key={index} className="core-field">
                    <span>Milestone {index + 1}</span>
                    <input type="number" min="1" step="1" value={reward} onChange={(event) => setRewards((values) => values.map((value, i) => i === index ? Number(event.target.value) : value))} />
                  </label>
                ))}
              </div>
              <p className="core-footnote">Submitting creates and funds a Sepolia job using the buyer signer configured on the API host.</p>
              <button className="btn btn-primary btn-block" disabled={!buyerToken.trim() || !eligibleWorkers.length || Boolean(pending)} onClick={createJob}>
                {pending === "create-job" ? "Submitting…" : "Create and fund job"}
              </button>
              {!eligibleWorkers.length && <p className="core-inline-hint">Connect a verified worker before creating a job.</p>}
            </section>
          </aside>

          <section className="core-main" aria-label="Jobs and checkpoints">
            <section className="core-panel core-jobs-panel">
              <div className="core-panel-heading">
                <div><p className="eyebrow">Buyer API state</p><h2>Jobs <span>{jobs.length}</span></h2></div>
                <span className="core-muted">{eligibleWorkers.length} eligible worker{eligibleWorkers.length === 1 ? "" : "s"}</span>
              </div>
              {jobs.length === 0 ? (
                <p className="core-empty">{loading ? "Loading jobs…" : "No live jobs yet. Create one after a worker is available."}</p>
              ) : (
                <div className="core-job-list" role="group" aria-label="Buyer jobs">
                  {jobs.map((item) => (
                    <button key={item.jobId} type="button" className={`core-job-item ${selectedJobId === item.jobId ? "is-selected" : ""}`} onClick={() => setSelectedJobId(item.jobId)}>
                      <span className="core-job-main"><b>{item.ensName || short(item.jobId)}</b><small className="mono">{short(item.jobId)}</small></span>
                      <span className="core-job-state"><Status value={item.phase} /><small>epoch {item.epoch} · {item.activeWorkerId ?? "unassigned"}</small></span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {job ? (
              <JobDetail
                job={job}
                workers={workers}
                alternateWorkers={alternateWorkers}
                takeoverWorker={takeoverWorker}
                setTakeoverWorker={setTakeoverWorker}
                reconciliation={reconciliation}
                pending={pending}
                tokenReady={Boolean(buyerToken.trim())}
                onAccept={acceptMilestone}
                onTakeover={requestTakeover}
                onReconcile={() => void reconcile()}
                onRetry={() => {
                  if (!window.confirm("Resume this job’s buyer-side provisioning and reconciliation?")) return;
                  void runAction("retry", async () => {
                    await postCoreAction(`/core/jobs/${job.jobId}/retry`, buyerToken.trim());
                  }, "Job retry requested.");
                }}
              />
            ) : (
              <section className="core-panel core-empty-detail">
                <p className="eyebrow">Job detail</p>
                <h2>{loading ? "Loading buyer state…" : "Select a live job"}</h2>
                <p className="core-muted">Accepted checkpoints, ENS assignments, transaction operations, and reconciliation will appear here.</p>
              </section>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function WorkerRow({ worker, tokenReady, pending, onConnect, onStop }: {
  worker: CoreWorker;
  tokenReady: boolean;
  pending: string;
  onConnect: () => void;
  onStop: () => void;
}) {
  const account = worker.runtime.account;
  const accountName = typeof account?.email === "string" ? account.email : worker.runtime.kind;
  return (
    <li className="core-worker">
      <div className="core-worker-top">
        <div><b>{worker.workerId}</b><Status value={worker.connection} /></div>
        <code>{short(worker.address)}</code>
      </div>
      <p className="core-worker-account">{accountName}{worker.smoke ? ` · smoke ${worker.smoke.passed ? "passed" : "failed"}` : " · smoke pending"}</p>
      {worker.loginUrl && worker.connection === "login_required" && <a className="core-login-link" href={worker.loginUrl} target="_blank" rel="noreferrer">Continue Codex sign-in ↗</a>}
      {worker.lastError && <p className="core-worker-error">{worker.lastError}</p>}
      <div className="core-worker-actions">
        {worker.alive ? (
          <button className="btn btn-ghost btn-sm" disabled={!tokenReady || Boolean(pending)} onClick={onStop}>{pending === `stop-${worker.workerId}` ? "Stopping…" : "Stop runtime"}</button>
        ) : (
          <button className="btn btn-ghost btn-sm" disabled={!tokenReady || Boolean(pending)} onClick={onConnect}>{pending === `connect-${worker.workerId}` ? "Starting…" : "Connect runtime"}</button>
        )}
        {worker.lastHeartbeatAt && <span>seen {timeAgo(worker.lastHeartbeatAt)}</span>}
      </div>
    </li>
  );
}

function JobDetail({ job, workers, alternateWorkers, takeoverWorker, setTakeoverWorker, reconciliation, pending, tokenReady, onAccept, onTakeover, onReconcile, onRetry }: {
  job: CoreJob;
  workers: CoreWorker[];
  alternateWorkers: CoreWorker[];
  takeoverWorker: string;
  setTakeoverWorker: (value: string) => void;
  reconciliation: CoreReconciliation | null;
  pending: string;
  tokenReady: boolean;
  onAccept: (milestone: number, rewardTokens: number) => void;
  onTakeover: () => void;
  onReconcile: () => void;
  onRetry: () => void;
}) {
  const operationItems = Object.values(job.ops).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return (
    <section className="core-panel core-detail-panel">
      <div className="core-detail-header">
        <div>
          <p className="eyebrow">{job.spec.title}</p>
          <h2>{job.ensName}</h2>
          <code className="core-job-id">{job.jobId}</code>
        </div>
        <div className="core-detail-state"><Status value={job.phase} /><span>epoch {job.epoch} · {job.activeWorkerId ?? "unassigned"}</span></div>
      </div>

      {job.lastError && <div className="core-inline-error">{job.lastError}</div>}

      <div className="core-readiness">
        {(["resources", "funding", "execution"] as const).map((key) => (
          <span key={key} className={job.readiness[key] ? "is-ready" : ""}><i />{key}</span>
        ))}
        <span className="core-readiness-worker">active: {job.activeWorkerId ?? "none"}</span>
      </div>

      <div className="core-detail-actions">
        <button className="btn btn-ghost btn-sm" disabled={Boolean(pending)} onClick={onReconcile}>{pending === "reconcile" ? "Reconciling…" : "Reconcile escrow"}</button>
        {job.phase !== "completed" && <button className="btn btn-ghost btn-sm" disabled={!tokenReady || Boolean(pending)} onClick={onRetry}>{pending === "retry" ? "Resuming…" : "Retry / resume"}</button>}
      </div>

      <div className="core-section">
        <div className="core-section-heading"><h3>Milestones</h3><span>{job.checkpoints.filter((checkpoint) => checkpoint.status === "accepted").length} accepted of {job.spec.milestones.length}</span></div>
        <ol className="core-milestones">
          {job.spec.milestones.map((milestone) => {
            const checkpoint = [...job.checkpoints].reverse().find((item) => item.milestone === milestone.index);
            return (
              <li className="core-milestone" key={milestone.index}>
                <div className="core-milestone-head">
                  <div><span className="core-milestone-number">{String(milestone.index).padStart(2, "0")}</span><div><b>{milestone.title}</b><small>{milestone.rewardTokens} tokens · {checkpoint ? `${checkpoint.status} · ${checkpoint.workerId}` : "awaiting checkpoint"}</small></div></div>
                  {checkpoint?.status === "verified" && <button className="btn btn-primary btn-sm" disabled={!tokenReady || Boolean(pending)} onClick={() => onAccept(milestone.index, milestone.rewardTokens)}>{pending === `accept-${milestone.index}` ? "Approving…" : "Approve"}</button>}
                </div>
                {checkpoint && <div className="core-checkpoint-meta"><span>sequence {checkpoint.sequence}</span><code>{short(checkpoint.manifestDigest)}</code>{checkpoint.acceptTx && <a href={`https://sepolia.etherscan.io/tx/${checkpoint.acceptTx}`} target="_blank" rel="noreferrer">accept tx ↗</a>}</div>}
                {checkpoint?.status === "rejected" && <ul className="core-checks">{checkpoint.checks.filter((check) => !check.ok).map((check) => <li key={check.name}>{check.name}{check.detail ? ` · ${check.detail}` : ""}</li>)}</ul>}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="core-section core-takeover-section">
        <div className="core-section-heading"><h3>Worker handoff</h3><span>{job.takeover ? job.takeover.status.replaceAll("_", " ") : "no takeover pending"}</span></div>
        {job.takeover && <p className="core-muted">{job.takeover.fromWorkerId} → {job.takeover.toWorkerId} · requested {timeAgo(job.takeover.requestedAt)}</p>}
        {job.phase === "running" && (
          <div className="core-takeover-controls">
            <select aria-label="Takeover successor" value={takeoverWorker} onChange={(event) => setTakeoverWorker(event.target.value)}>
              <option value="">Auto-select verified successor</option>
              {alternateWorkers.map((worker) => <option key={worker.workerId} value={worker.workerId}>{worker.workerId} · {short(worker.address)}</option>)}
            </select>
            <button className="btn btn-ghost btn-sm" disabled={!tokenReady || Boolean(pending) || (!alternateWorkers.length && !takeoverWorker)} onClick={onTakeover}>{pending === "takeover" ? "Requesting…" : "Request takeover"}</button>
          </div>
        )}
        {job.phase !== "running" && job.phase !== "takeover" && <p className="core-muted">Takeover controls are available while a job is running.</p>}
      </div>

      <div className="core-section">
        <div className="core-section-heading"><h3>Assignments</h3><span>{job.assignments.length}</span></div>
        <div className="core-assignment-list">
          {job.assignments.map((assignment, index) => (
            <div className="core-assignment" key={`${assignment.workerId}-${assignment.epoch}`}>
              <span className="core-assignment-index">{String(index + 1).padStart(2, "0")}</span>
              <div><b>{assignment.workerId}</b><small>{workers.find((worker) => worker.workerId === assignment.workerId)?.connection ?? "worker"} · {assignment.ensName || "ENS provisioning"}</small></div>
              <span>epoch {assignment.epoch} · {assignment.status}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="core-section">
        <div className="core-section-heading"><h3>Operations</h3><span>{operationItems.length}</span></div>
        {operationItems.length === 0 ? <p className="core-muted">No buyer-side operations recorded yet.</p> : (
          <div className="core-operation-list">
            {operationItems.slice(0, 8).map((operation) => (
              <div className="core-operation" key={operation.key}>
                <div><b>{operation.intent}</b><small>{operation.network} · {operation.updatedAt ? timeAgo(operation.updatedAt) : ""}</small></div>
                <Status value={operation.status} />
                {operation.txHash && <a href={`https://sepolia.etherscan.io/tx/${operation.txHash}`} target="_blank" rel="noreferrer">tx ↗</a>}
                {operation.error && <small className="core-worker-error">{operation.error}</small>}
              </div>
            ))}
          </div>
        )}
      </div>

      {reconciliation && (
        <div className="core-reconciliation" role="status">
          <div><b>Escrow accounting</b><Status value={reconciliation.conserved ? "conserved" : "mismatch"} /></div>
          <p>Reward pool: {reconciliation.rewardPool} raw units · unallocated: {reconciliation.unallocated} · outstanding: {reconciliation.outstandingCredits}</p>
          <p>Withdrawn: {reconciliation.totalWithdrawn} · refunded: {reconciliation.totalRefunded}</p>
          {reconciliation.workers.map((worker) => <small key={worker.workerId}>{worker.workerId}: credited {worker.credited}, withdrawn {worker.withdrawn}</small>)}
        </div>
      )}
    </section>
  );
}

function Status({ value }: { value: string }) {
  const status = value.toLowerCase().replaceAll(" ", "-");
  return <span className={`core-status status-${status}`}><i />{value.replaceAll("_", " ")}</span>;
}

function short(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function timeAgo(value: string) {
  const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (!Number.isFinite(elapsed)) return "unknown time";
  if (elapsed < 60) return `${elapsed}s ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  return `${Math.floor(elapsed / 3600)}h ago`;
}
