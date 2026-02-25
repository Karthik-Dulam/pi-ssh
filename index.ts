import { spawn } from "node:child_process";
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
  remoteCwd: string;
  localCwd: string;
}

interface SshCaptureOptions {
  stdin?: string | Buffer;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function mapLocalPathToRemote(path: string, conn: SshConnection): string {
  if (path === conn.localCwd) return conn.remoteCwd;
  if (path.startsWith(`${conn.localCwd}/`)) {
    return `${conn.remoteCwd}${path.slice(conn.localCwd.length)}`;
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

function buildResolveRemotePathCommand(remotePath: string): string {
  // The path argument is always shell quoted for safety.
  // Use absolute paths for best reliability.
  return `cd -- ${shellQuote(remotePath)} && pwd`;
}

async function sshCapture(
  remote: string,
  remoteCommand: string,
  options: SshCaptureOptions = {},
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [remote, "bash", "-lc", remoteCommand], {
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

async function sshExec(remote: string, remoteCommand: string, options: SshCaptureOptions = {}): Promise<Buffer> {
  const result = await sshCapture(remote, remoteCommand, options);
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

function createRemoteReadOps(conn: SshConnection): ReadOperations {
  return {
    readFile: (absolutePath) => {
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      return sshExec(conn.remote, `cat -- ${shellQuote(remotePath)}`);
    },
    access: async (absolutePath) => {
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      await sshExec(conn.remote, `test -r ${shellQuote(remotePath)}`);
    },
    detectImageMimeType: async (absolutePath) => {
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      try {
        const output = await sshExec(
          conn.remote,
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
      await sshExec(conn.remote, `mkdir -p -- ${shellQuote(remoteDir)}`);
    },
    writeFile: async (absolutePath, content) => {
      const remotePath = mapLocalPathToRemote(absolutePath, conn);
      await sshExec(conn.remote, `cat > ${shellQuote(remotePath)}`, {
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
      await sshExec(conn.remote, `test -r ${shellQuote(remotePath)} && test -w ${shellQuote(remotePath)}`);
    },
  };
}

function createRemoteBashOps(conn: SshConnection): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        const remoteCwd = mapLocalPathToRemote(cwd, conn);
        const remoteCommand = `cd -- ${shellQuote(remoteCwd)} && ${command}`;

        const child = spawn("ssh", [conn.remote, "bash", "-lc", remoteCommand], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        const timeoutHandle =
          timeout && timeout > 0
            ? setTimeout(() => {
                timedOut = true;
                child.kill();
              }, timeout * 1000)
            : undefined;

        const onAbort = () => child.kill();
        if (signal) {
          if (signal.aborted) {
            child.kill();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (error) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(error);
        });

        child.on("close", (exitCode) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
            return;
          }

          resolve({ exitCode });
        });
      }),
  };
}

async function resolveSshConnection(rawFlag: string, localCwd: string): Promise<SshConnection> {
  const parsed = parseSshFlag(rawFlag);

  if (!parsed.remotePath) {
    const remotePwd = await sshExec(parsed.remote, "pwd", { timeoutSeconds: 15 });
    return {
      remote: parsed.remote,
      remoteCwd: remotePwd.toString("utf-8").trim(),
      localCwd,
    };
  }

  const resolvedPath = await sshExec(parsed.remote, buildResolveRemotePathCommand(parsed.remotePath), {
    timeoutSeconds: 15,
  });

  return {
    remote: parsed.remote,
    remoteCwd: resolvedPath.toString("utf-8").trim(),
    localCwd,
  };
}

export default function piSshExtension(pi: ExtensionAPI): void {
  pi.registerFlag("ssh", {
    description: "SSH target as user@host or user@host:/absolute/remote/path",
    type: "string",
  });

  const localCwd = process.cwd();

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let connection: SshConnection | null = null;

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
      const conn = getConnection();
      if (!conn) {
        return localBash.execute(id, params, signal, onUpdate);
      }
      const tool = createBashTool(localCwd, { operations: createRemoteBashOps(conn) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const flag = pi.getFlag("ssh") as string | undefined;
    if (!flag) return;

    try {
      connection = await resolveSshConnection(flag, localCwd);
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "pi-ssh",
          ctx.ui.theme.fg("accent", `SSH ${connection.remote}:${connection.remoteCwd}`),
        );
        ctx.ui.notify(`pi-ssh enabled: ${connection.remote}:${connection.remoteCwd}`, "info");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      connection = null;
      if (ctx.hasUI) {
        ctx.ui.setStatus("pi-ssh", undefined);
        ctx.ui.notify(`pi-ssh failed to connect: ${message}`, "error");
      }
      throw error;
    }
  });

  pi.on("user_bash", () => {
    const conn = getConnection();
    if (!conn) return;
    return { operations: createRemoteBashOps(conn) };
  });

  pi.on("before_agent_start", async (event) => {
    const conn = getConnection();
    if (!conn) return;

    const localPrefix = `Current working directory: ${localCwd}`;
    const remotePrefix = `Current working directory: ${conn.remoteCwd} (via SSH ${conn.remote})`;

    if (!event.systemPrompt.includes(localPrefix)) return;
    return {
      systemPrompt: event.systemPrompt.replace(localPrefix, remotePrefix),
    };
  });
}
