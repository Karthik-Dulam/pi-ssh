import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";

interface SshConnection {
  remote: string;
  port: number;
  remoteCwd: string;
  remoteHome: string;
  localCwd: string;
  localHome: string;
}

interface SshCaptureOptions {
  stdin?: string | Buffer;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

interface RunningCommand {
  startMarker: string;
  endMarker: string;
  timeout?: number;
  onData: (chunk: Buffer) => void;
  signal?: AbortSignal;
  aborted: boolean;
  timedOut: boolean;
  timeoutHandle?: NodeJS.Timeout;
  abortHandler?: () => void;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  resolve: (value: { exitCode: number | null }) => void;
  reject: (error: Error) => void;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDelimitedShellOutput(
  stdoutText: string,
  startMarker: string,
  endMarker: string,
): { output: string; exitCode: number | null } | null {
  const text = stdoutText.replace(/\r\n/g, "\n");

  const endRegex = new RegExp(`(^|\\n)${escapeRegex(endMarker)}:(-?\\d+)(?=\\n|$)`);
  const endMatch = endRegex.exec(text);
  if (!endMatch) {
    return null;
  }

  const endLineStart = endMatch.index + endMatch[1].length;

  const startRegex = new RegExp(`(^|\\n)${escapeRegex(startMarker)}(?=\\n|$)`, "g");
  let startLineEnd = 0;
  let foundStart = false;
  while (true) {
    const startMatch = startRegex.exec(text);
    if (!startMatch) break;

    const startLineStart = startMatch.index + startMatch[1].length;
    if (startLineStart >= endLineStart) break;

    foundStart = true;
    startLineEnd = startLineStart + startMarker.length;
    if (text[startLineEnd] === "\n") {
      startLineEnd += 1;
    }
  }

  if (!foundStart) {
    return null;
  }

  const output = text.slice(startLineEnd, endLineStart);
  const parsedExitCode = Number(endMatch[2]);
  const exitCode = Number.isNaN(parsedExitCode) ? null : parsedExitCode;
  return { output, exitCode };
}

function mapLocalPathToRemote(path: string, conn: SshConnection): string {
  if (path === conn.localCwd) return conn.remoteCwd;
  if (path.startsWith(`${conn.localCwd}/`)) {
    return `${conn.remoteCwd}${path.slice(conn.localCwd.length)}`;
  }
  if (path === conn.localHome) return conn.remoteHome;
  if (path.startsWith(`${conn.localHome}/`)) {
    return `${conn.remoteHome}${path.slice(conn.localHome.length)}`;
  }
  return path;
}

function parseSshFlag(raw: string): { remote: string; remotePath?: string } {
  const value = raw.trim();
  if (!value) {
    throw new Error("--ssh requires a value like user@host or user@host:/remote/path");
  }

  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    return { remote: value };
  }

  const remote = value.slice(0, colonIndex).trim();
  const remotePath = value.slice(colonIndex + 1).trim();
  if (!remote) {
    throw new Error("Invalid --ssh value: missing remote host");
  }
  if (!remotePath) {
    throw new Error("Invalid --ssh value: empty remote path");
  }
  return { remote, remotePath };
}

function parseSshPort(raw: string | undefined): number {
  const value = (raw ?? "22").trim();
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid SSH port: ${value}`);
  }
  return parsed;
}

function buildSshBaseArgs(port: number): string[] {
  return [
    "-p",
    String(port),
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=600",
    "-o",
    "ControlPath=/tmp/pi-ssh-%C",
  ];
}

function buildResolveRemotePathCommand(remotePath: string): string {
  if (remotePath === "~") {
    return 'cd -- "$HOME" && pwd';
  }
  if (remotePath.startsWith("~/")) {
    return `cd -- "$HOME"/${shellQuote(remotePath.slice(2))} && pwd`;
  }
  return `cd -- ${shellQuote(remotePath)} && pwd`;
}

async function sshCapture(
  remote: string,
  port: number,
  remoteCommand: string,
  options: SshCaptureOptions = {},
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...buildSshBaseArgs(port), remote, remoteCommand], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timeoutHandle =
      options.timeoutSeconds && options.timeoutSeconds > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutSeconds * 1000)
        : undefined;

    const onAbort = () => child.kill();
    if (options.signal) {
      if (options.signal.aborted) {
        child.kill();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("close", (exitCode) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode,
        timedOut,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

async function sshExec(remote: string, port: number, remoteCommand: string, options: SshCaptureOptions = {}): Promise<Buffer> {
  const result = await sshCapture(remote, port, remoteCommand, options);
  if (result.timedOut) {
    throw new Error(`SSH command timed out after ${options.timeoutSeconds ?? 0}s`);
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString("utf-8").trim();
    const message = stderr || `SSH command failed with exit code ${result.exitCode}`;
    throw new Error(message);
  }
  return result.stdout;
}

class PersistentRemoteShell {
  private connection: SshConnection;
  private child: ChildProcessWithoutNullStreams | null = null;
  private running: RunningCommand | null = null;
  private queueTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(connection: SshConnection) {
    this.connection = connection;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.running) {
      this.running.reject(new Error("Remote shell disposed"));
      this.running = null;
    }
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
  }

  exec(command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }): Promise<{ exitCode: number | null }> {
    const run = this.queueTail.then(() => this.execOne(command, cwd, options));
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error("Remote shell is disposed");
    }
    if (this.child && !this.child.killed) {
      return;
    }

    const child = spawn("ssh", [...buildSshBaseArgs(this.connection.port), "-tt", this.connection.remote], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.on("error", (error) => {
      if (this.running) {
        this.running.reject(error instanceof Error ? error : new Error(String(error)));
        this.cleanupRunning();
      }
    });

    child.on("close", () => {
      if (this.running) {
        this.running.reject(new Error("SSH shell closed unexpectedly"));
        this.cleanupRunning();
      }
      this.child = null;
    });

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));

    this.child = child;
    this.child.stdin.write(
      "stty -echo 2>/dev/null || true; unset PROMPT_COMMAND 2>/dev/null || true; PS1=''; PROMPT=''; RPROMPT=''; " +
        "if [ -n \"${ZSH_VERSION-}\" ]; then precmd_functions=(); preexec_functions=(); chpwd_functions=(); unset zle_bracketed_paste 2>/dev/null || true; fi; " +
        "if [ -n \"${BASH_VERSION-}\" ]; then bind 'set enable-bracketed-paste off' 2>/dev/null || true; fi\n",
    );
    this.child.stdin.write(`cd -- ${shellQuote(this.connection.remoteCwd)}\n`);
  }

  private handleStdout(chunk: Buffer): void {
    const running = this.running;
    if (!running) return;
    running.stdoutChunks.push(chunk);
    this.tryCompleteRunning();
  }

  private handleStderr(chunk: Buffer): void {
    const running = this.running;
    if (!running) return;
    running.stderrChunks.push(chunk);
  }

  private tryCompleteRunning(): void {
    const running = this.running;
    if (!running) return;

    const stdoutText = Buffer.concat(running.stdoutChunks).toString("utf-8");
    const parsed = parseDelimitedShellOutput(stdoutText, running.startMarker, running.endMarker);
    if (!parsed) return;

    const cleanStdout = Buffer.from(parsed.output, "utf-8");
    const cleanStderr = Buffer.concat(running.stderrChunks);
    const merged = Buffer.concat([cleanStdout, cleanStderr]);
    if (merged.length > 0) {
      running.onData(merged);
    }

    const exitCode = parsed.exitCode;
    const timedOut = running.timedOut;
    const aborted = running.aborted;
    const timeout = running.timeout;

    this.cleanupRunning();

    if (timedOut) {
      running.reject(new Error(`timeout:${timeout}`));
      return;
    }
    if (aborted) {
      running.reject(new Error("aborted"));
      return;
    }

    running.resolve({ exitCode });
  }

  private cleanupRunning(): void {
    if (!this.running) return;
    if (this.running.timeoutHandle) clearTimeout(this.running.timeoutHandle);
    if (this.running.signal && this.running.abortHandler) {
      this.running.signal.removeEventListener("abort", this.running.abortHandler);
    }
    this.running = null;
  }

  private interruptCurrentCommand(): void {
    if (!this.child || this.child.killed) return;
    // Send Ctrl-C to remote TTY; this interrupts the foreground command
    // but keeps the SSH shell session alive.
    this.child.stdin.write("\x03");
  }

  private async execOne(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ): Promise<{ exitCode: number | null }> {
    await this.ensureStarted();
    if (!this.child || this.child.killed) {
      throw new Error("Failed to start persistent SSH shell");
    }

    const unique = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const startMarker = `__PI_SSH_BEGIN_${unique}__`;
    const endMarker = `__PI_SSH_DONE_${unique}__`;
    const remoteCwd = mapLocalPathToRemote(cwd, this.connection);

    const wrappedCommand = [
      `printf '${startMarker}\\n'`,
      `if cd -- ${shellQuote(remoteCwd)}; then`,
      `  { ${command}; }`,
      "  __pi_ec=$?",
      "else",
      "  __pi_ec=$?",
      "fi",
      `printf '${endMarker}:%s\\n' \"$__pi_ec\"`,
    ].join("\n");

    return new Promise((resolve, reject) => {
      const running: RunningCommand = {
        startMarker,
        endMarker,
        timeout: options.timeout,
        onData: options.onData,
        signal: options.signal,
        aborted: false,
        timedOut: false,
        stdoutChunks: [],
        stderrChunks: [],
        resolve,
        reject,
      };

      if (options.timeout && options.timeout > 0) {
        running.timeoutHandle = setTimeout(() => {
          running.timedOut = true;
          this.interruptCurrentCommand();
        }, options.timeout * 1000);
      }

      if (options.signal) {
        running.abortHandler = () => {
          running.aborted = true;
          this.interruptCurrentCommand();
        };

        if (options.signal.aborted) {
          running.abortHandler();
        } else {
          options.signal.addEventListener("abort", running.abortHandler, { once: true });
        }
      }

      this.running = running;
      this.child?.stdin.write(`${wrappedCommand}\n`);
    });
  }
}

function createRemoteReadOps(conn: SshConnection): ReadOperations {
  return {
    readFile: (absolutePath) => {
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      return sshExec(conn.remote, conn.port, `cat -- ${shellQuote(remotePath)}`);
    },
    access: async (absolutePath) => {
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      await sshExec(conn.remote, conn.port, `test -r ${shellQuote(remotePath)}`);
    },
    detectImageMimeType: async (absolutePath) => {
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      try {
        const output = await sshExec(
          conn.remote,
          conn.port,
          `file --mime-type -b -- ${shellQuote(remotePath)} 2>/dev/null || true`,
        );
        const mime = output.toString("utf-8").trim();
        if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) {
          return mime;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}

function createRemoteWriteOps(conn: SshConnection): WriteOperations {
  return {
    mkdir: async (absoluteDir) => {
      const remoteDir = mapLocalPathToRemote(absoluteDir, conn);
      await sshExec(conn.remote, conn.port, `mkdir -p -- ${shellQuote(remoteDir)}`);
    },
    writeFile: async (absolutePath, content) => {
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      await sshExec(conn.remote, conn.port, `cat > ${shellQuote(remotePath)}`, {
        stdin: Buffer.from(content, "utf-8"),
      });
    },
  };
}

function createRemoteEditOps(conn: SshConnection): EditOperations {
  const readOps = createRemoteReadOps(conn);
  const writeOps = createRemoteWriteOps(conn);

  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: async (absolutePath) => {
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      await sshExec(conn.remote, conn.port, `test -r ${shellQuote(remotePath)} && test -w ${shellQuote(remotePath)}`);
    },
  };
}

function createRemoteBashOps(shell: PersistentRemoteShell): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) => {
      return shell.exec(command, cwd, { onData, signal, timeout });
    },
  };
}

async function resolveSshConnection(rawFlag: string, localCwd: string, localHome: string, port: number): Promise<SshConnection> {
  const parsed = parseSshFlag(rawFlag);

  const remoteHomeBuffer = await sshExec(parsed.remote, port, 'printf "%s" "$HOME"', {
    timeoutSeconds: 15,
  });
  const remoteHome = remoteHomeBuffer.toString("utf-8").trim();

  if (!remoteHome) {
    throw new Error("Failed to detect remote HOME");
  }

  if (!parsed.remotePath) {
    const remotePwd = await sshExec(parsed.remote, port, "pwd", { timeoutSeconds: 15 });
    return {
      remote: parsed.remote,
      port,
      remoteCwd: remotePwd.toString("utf-8").trim(),
      remoteHome,
      localCwd,
      localHome,
    };
  }

  const resolvedPath = await sshExec(parsed.remote, port, buildResolveRemotePathCommand(parsed.remotePath), {
    timeoutSeconds: 15,
  });

  return {
    remote: parsed.remote,
    port,
    remoteCwd: resolvedPath.toString("utf-8").trim(),
    remoteHome,
    localCwd,
    localHome,
  };
}

export default function piSshExtension(pi: ExtensionAPI): void {
  pi.registerFlag("ssh", {
    description: "SSH target as user@host or user@host:/absolute/remote/path",
    type: "string",
  });
  pi.registerFlag("ssh-port", {
    description: "SSH port (default: 22)",
    type: "string",
    default: "22",
  });
  pi.registerFlag("p", {
    description: "Alias for --ssh-port",
    type: "string",
  });

  const localCwd = process.cwd();
  const localHome = homedir();

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let connection: SshConnection | null = null;
  let persistentShell: PersistentRemoteShell | null = null;

  const getConnection = () => connection;

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate) {
      const conn = getConnection();
      if (!conn) {
        return localRead.execute(id, params, signal, onUpdate);
      }
      const tool = createReadTool(localCwd, { operations: createRemoteReadOps(conn) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate) {
      const conn = getConnection();
      if (!conn) {
        return localWrite.execute(id, params, signal, onUpdate);
      }
      const tool = createWriteTool(localCwd, { operations: createRemoteWriteOps(conn) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate) {
      const conn = getConnection();
      if (!conn) {
        return localEdit.execute(id, params, signal, onUpdate);
      }
      const tool = createEditTool(localCwd, { operations: createRemoteEditOps(conn) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate) {
      const shell = persistentShell;
      if (!shell) {
        return localBash.execute(id, params, signal, onUpdate);
      }
      const tool = createBashTool(localCwd, { operations: createRemoteBashOps(shell) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const flag = pi.getFlag("ssh") as string | undefined;
    if (!flag) return;

    try {
      const rawPort = (pi.getFlag("p") as string | undefined) ?? (pi.getFlag("ssh-port") as string | undefined);
      const port = parseSshPort(rawPort);
      connection = await resolveSshConnection(flag, localCwd, localHome, port);
      persistentShell = new PersistentRemoteShell(connection);
      const enabledMessage = `pi-ssh enabled: ${connection.remote}:${connection.remoteCwd} (port ${connection.port})`;
      console.log(enabledMessage);
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "pi-ssh",
          ctx.ui.theme.fg("accent", `SSH ${connection.remote}:${connection.remoteCwd} (port ${connection.port})`),
        );
        ctx.ui.notify(enabledMessage, "info");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      connection = null;
      if (persistentShell) {
        await persistentShell.dispose();
        persistentShell = null;
      }
      console.error(`pi-ssh failed to connect: ${message}`);
      if (ctx.hasUI) {
        ctx.ui.setStatus("pi-ssh", undefined);
        ctx.ui.notify(`pi-ssh failed to connect: ${message}`, "error");
      }
      throw error;
    }
  });

  pi.on("session_shutdown", async () => {
    if (persistentShell) {
      await persistentShell.dispose();
      persistentShell = null;
    }
  });

  pi.on("user_bash", () => {
    const shell = persistentShell;
    if (!shell) return;
    return { operations: createRemoteBashOps(shell) };
  });

  pi.on("before_agent_start", async (event) => {
    const conn = getConnection();
    if (!conn) return;

    const localPrefix = `Current working directory: ${localCwd}`;
    const remotePrefix = `Current working directory: ${conn.remoteCwd} (via SSH ${conn.remote}, port ${conn.port})`;

    if (!event.systemPrompt.includes(localPrefix)) return;
    return {
      systemPrompt: event.systemPrompt.replace(localPrefix, remotePrefix),
    };
  });
}
