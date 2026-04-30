import { spawn } from "node:child_process";

export type CommandResult = {
  code: number | null;
  output: string;
};

export function runCommand(command: string, args: string[], timeoutMs = 10 * 60 * 1000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const timer = setTimeout(() => {
      output += "\nCommand timed out and was terminated.\n";
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: 127,
        output: output + error.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
