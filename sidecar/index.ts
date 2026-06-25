import { createWorld } from "@workflow-worlds/turso";
createWorld({ databaseUrl: "file:eve-offline.db" });

import { Elysia } from "elysia";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { execSync } from "child_process";
import { loadConfig, saveConfig, getConfigPath } from "./config";

// Rust sets EVE_RESOURCE_DIR to the project root (dev) or bundled resource dir (prod).
// process.cwd() is a safe fallback that works during `bun run sidecar` in dev.
const BASE_DIR: string = process.env.EVE_RESOURCE_DIR ?? process.cwd();
console.log(`[sidecar] BASE_DIR: ${BASE_DIR}`);


// GPU detection
function detectGPU(): "cuda" | "vulkan" | "cpu" {
  if (os.platform() === "win32") {
    try { execSync("nvidia-smi", { stdio: "ignore" }); return "cuda"; } catch {}
    try { execSync("vulkaninfo", { stdio: "ignore" }); return "vulkan"; } catch {}
  }
  return "cpu";
}

// Load config
const config = await loadConfig();
console.log(`Config loaded from: ${getConfigPath()}`);

if (!config.modelPath) {
  console.log("No model configured. Set modelPath in config to load a model.");
}

// Spawn llama-server
let llamaProcess: ChildProcess | null = null;
const LLAMA_PORT = 8080;

// Get llama-server binary path
function getLlamaServerBinary(): string {
  const platform = os.platform();
  const arch = os.arch();
  const resourceDir = process.env.TAURI_RESOURCE_DIR ??
    path.join(process.cwd(), "src-tauri", "binaries");

  if (platform === "win32") {
    const gpu = detectGPU();
    console.log(`Detected GPU backend: ${gpu}`);
    return path.join(resourceDir, "win-x64", gpu, "llama-server.exe");
  } else if (platform === "darwin") {
    return arch === "arm64"
      ? path.join(resourceDir, "mac-arm64", "llama-server")
      : path.join(resourceDir, "mac-x64", "llama-server");
  } else {
    return path.join(resourceDir, "linux-x64", "llama-server");
  }
}

async function startLlamaServer(): Promise<void> {
  if (!config.modelPath) {
    console.log("No model configured. Skipping llama-server startup.");
    return;
  }

  const binary = getLlamaServerBinary();
  console.log(`Starting llama-server: ${binary}`);

  llamaProcess = spawn(binary, [
    "--model", config.modelPath,
    "--port", String(LLAMA_PORT),
    "--host", "127.0.0.1",
    "--ctx-size", "4096",
    "-ngl", "99",  // offload all layers to GPU
  ], {
    cwd: path.dirname(binary), // run from binary dir so DLLs resolve
    stdio: ["ignore", "pipe", "pipe"],
  });

  llamaProcess.stdout?.on("data", (d) => process.stdout.write(`[llama] ${d}`));
  llamaProcess.stderr?.on("data", (d) => process.stderr.write(`[llama] ${d}`));

  // Wait for llama-server to be ready
  await waitForLlama();
}

async function waitForLlama(retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${LLAMA_PORT}/health`);
      if (res.ok) {
        console.log("llama-server ready");
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("llama-server failed to start after 30 seconds");
}


// Agent runner
async function runAgent(agentName: string, message: string) {
  "use workflow"
  console.log("Reading Instructions")
  const instructions = await readInstructions(agentName);
  console.log("Instructions read")
  console.log("Running Inference")
  const response = await callLlama(instructions, message);
  return response;
}

async function readInstructions(agentName: string) {
  "use step";
  const instructionsPath = path.join(
    BASE_DIR, "agents", agentName, "agent", "instructions.md"
  );
  console.log("Agent Instruction Path: ", instructionsPath)
  const instructions = await fs.readFile(instructionsPath, "utf-8");
  console.log("Instructions: ", instructions.substring(0, 100))
  return instructions;
}

async function callLlama(systemPrompt: string, message: string) {
  "use step";
  const res = await fetch(`http://127.0.0.1:${LLAMA_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
    }),
  });
  const data = await res.json() as any;
  return data.choices[0].message.content;
}

// Start llama-server then boot Elysia
await startLlamaServer();

const app = new Elysia()
  .get("/health", () => ({ status: "ok", modelLoaded: !!config.modelPath }))
  .get("/config", async () => await loadConfig())
  .post("/config", async ({ body }: { body: any }) => {
    await saveConfig(body);
    return { success: true };
  })
  .post("/agents/:name/run", async ({ params, body }: { params: any; body: any }) => {
    const response = await runAgent(params.name, body.message);
    return { response };
  })
  .listen(config.port);

console.log(`Eve sidecar running on port ${app.server?.port}`);

// Cleanup on exit
process.on("exit", () => llamaProcess?.kill());
process.on("SIGINT", () => { llamaProcess?.kill(); process.exit(); });