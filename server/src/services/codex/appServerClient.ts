import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

/**
 * Minimal client for the stable Codex app-server protocol (JSON-RPC 2.0 over
 * newline-delimited JSON on stdio, with the "jsonrpc" field omitted on the wire).
 * Verified against codex-cli 0.164.0 `codex app-server generate-ts` bindings.
 */
export type AppServerOptions = {
  codexBin?: string;
  /** Isolated CODEX_HOME holding this worker's own auth.json and runtime state. */
  codexHome: string;
  /** `-c key=value` overrides, already TOML-encoded on the value side. */
  config?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  clientName: string;
  clientVersion: string;
  requestTimeoutMs?: number;
};

export type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class AppServerError extends Error {
  public constructor(message: string, public readonly code?: number) {
    super(message);
  }
}

export type CodexAccount =
  | { type: "chatgpt"; email: string | null; planType: string }
  | { type: "apiKey" }
  | { type: string; [key: string]: unknown };

export type TurnOutcome = {
  turnId: string;
  status: string;
  finalMessage: string;
  agentMessages: string[];
  mcpToolCalls: Array<{ server: string; tool: string; status: string; arguments: unknown; error?: unknown }>;
  commandCount: number;
  fileChangeCount: number;
  commandOutputs: string[];
  error?: string;
};

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stderrTail: string[] = [];
  private exited = false;

  public constructor(private readonly options: AppServerOptions) {
    super();
  }

  public async start(): Promise<void> {
    const args = ["app-server"];
    for (const [key, value] of Object.entries(this.options.config ?? {})) args.push("-c", `${key}=${value}`);
    const child = spawn(this.options.codexBin ?? "codex", args, {
      env: { ...(this.options.env ?? process.env), CODEX_HOME: this.options.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.on("exit", (code, signal) => {
      this.exited = true;
      const error = new AppServerError(`codex app-server exited (${code ?? signal})`);
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });
    child.on("error", (error) => this.emit("processError", error));
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    await this.request("initialize", {
      clientInfo: { name: this.options.clientName, title: "BATON worker", version: this.options.clientVersion },
    });
    this.notify("initialized", {});
  }

  public get running(): boolean {
    return this.child !== undefined && !this.exited;
  }

  public recentStderr(): string[] {
    return [...this.stderrTail];
  }

  public async stop(): Promise<void> {
    if (!this.child || this.exited) return;
    const child = this.child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  public request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.child || this.exited) return Promise.reject(new AppServerError("codex app-server is not running"));
    const id = this.nextId++;
    const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`${method} timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  public notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  public async readAccount(refreshToken = false): Promise<{ account: CodexAccount | null; requiresOpenaiAuth: boolean }> {
    return this.request("account/read", { refreshToken });
  }

  /** Starts the official ChatGPT browser sign-in; the app-server hosts the localhost callback. */
  public async startChatGptLogin(): Promise<{ loginId: string; authUrl: string }> {
    const response = await this.request<{ type: string; loginId: string; authUrl: string }>("account/login/start", { type: "chatgpt" });
    if (response.type !== "chatgpt" || !response.authUrl) throw new AppServerError("Unexpected login response");
    return { loginId: response.loginId, authUrl: response.authUrl };
  }

  public waitForLogin(loginId: string, timeoutMs: number): Promise<{ success: boolean; error?: string | null }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("notification", listener);
        reject(new AppServerError("Timed out waiting for browser sign-in"));
      }, timeoutMs);
      const listener = (message: JsonRpcMessage) => {
        if (message.method !== "account/login/completed") return;
        const params = message.params as { loginId?: string | null; success: boolean; error?: string | null };
        if (params.loginId && params.loginId !== loginId) return;
        clearTimeout(timer);
        this.off("notification", listener);
        resolve({ success: params.success, error: params.error ?? null });
      };
      this.on("notification", listener);
    });
  }

  public async startThread(params: {
    cwd: string;
    model?: string;
    developerInstructions?: string;
    sandbox?: "read-only" | "workspace-write";
  }): Promise<string> {
    const response = await this.request<{ thread: { id: string } }>("thread/start", {
      cwd: params.cwd,
      model: params.model ?? null,
      approvalPolicy: "never",
      // Omitted when the runtime uses a named permissions profile; the two must not be combined.
      ...(params.sandbox ? { sandbox: params.sandbox } : {}),
      developerInstructions: params.developerInstructions ?? null,
      serviceName: "baton-worker",
      ephemeral: false,
    });
    return response.thread.id;
  }

  /** Runs one turn to completion and collects the authoritative completed items. */
  public async runTurn(threadId: string, text: string, timeoutMs: number, onActivity?: (event: string, detail: unknown) => void): Promise<TurnOutcome> {
    const outcome: TurnOutcome = { turnId: "", status: "unknown", finalMessage: "", agentMessages: [], mcpToolCalls: [], commandCount: 0, fileChangeCount: 0, commandOutputs: [] };
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const listener = (message: JsonRpcMessage) => {
      const params = (message.params ?? {}) as Record<string, any>;
      if (params.threadId && params.threadId !== threadId) return;
      if (message.method === "item/completed") {
        const item = params.item ?? {};
        if (item.type === "agentMessage") {
          outcome.agentMessages.push(String(item.text ?? ""));
          onActivity?.("agentMessage", { text: String(item.text ?? "").slice(0, 400) });
        } else if (item.type === "mcpToolCall") {
          outcome.mcpToolCalls.push({ server: item.server, tool: item.tool, status: item.status, arguments: item.arguments, error: item.error ?? undefined });
          onActivity?.("toolCall", { server: item.server, tool: item.tool, status: item.status });
        } else if (item.type === "commandExecution") {
          outcome.commandCount += 1;
          outcome.commandOutputs.push(String(item.aggregatedOutput ?? ""));
          onActivity?.("command", { command: String(item.command ?? "").slice(0, 200), exitCode: item.exitCode ?? null });
        } else if (item.type === "fileChange") {
          outcome.fileChangeCount += 1;
          onActivity?.("fileChange", { paths: (item.changes ?? []).map((change: { path?: string }) => change.path) });
        }
      } else if (message.method === "error") {
        outcome.error = String(params.error?.message ?? "turn error");
        onActivity?.("error", { message: outcome.error, willRetry: params.willRetry ?? null });
      } else if (message.method === "turn/completed") {
        const turn = params.turn ?? {};
        if (outcome.turnId && turn.id && turn.id !== outcome.turnId) return;
        outcome.status = String(turn.status ?? "unknown");
        if (turn.error?.message) outcome.error = String(turn.error.message);
        resolveDone();
      }
    };
    this.on("notification", listener);
    try {
      const started = await this.request<{ turn: { id: string } }>("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
      outcome.turnId = started.turn.id;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppServerError(`turn timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      const exited = new Promise<never>((_, reject) => this.once("exit", () => reject(new AppServerError("codex app-server exited during turn"))));
      try {
        await Promise.race([done, timeout, exited]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.off("notification", listener);
    }
    outcome.finalMessage = outcome.agentMessages.at(-1) ?? "";
    return outcome;
  }

  private write(message: JsonRpcMessage): void {
    this.child?.stdin.write(JSON.stringify(message) + "\n");
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(Number(message.id));
      if (!entry) return;
      this.pending.delete(Number(message.id));
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new AppServerError(message.error.message, message.error.code));
      else entry.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    this.emit("notification", message);
  }

  /**
   * BATON workers run with approvalPolicy "never". Any approval request that still
   * arrives is declined: protected actions go through BATON tools, not ad-hoc escalation.
   */
  private handleServerRequest(message: JsonRpcMessage): void {
    const method = message.method ?? "";
    this.emit("serverRequest", { method });
    if (method.endsWith("requestApproval") || method === "execCommandApproval" || method === "applyPatchApproval") {
      this.write({ id: message.id, result: { decision: method.startsWith("item/") ? "decline" : "denied" } });
      return;
    }
    this.write({ id: message.id, error: { code: -32601, message: `BATON worker does not handle ${method}` } });
  }
}
