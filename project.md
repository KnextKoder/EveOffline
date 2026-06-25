# eve-offline — Project State & Handoff Document

## Overview

**eve-offline** is an offline-first desktop app built on Vercel's Eve agent framework. It allows users to create, manage, and run locally-hosted AI agents powered by locally-running LLMs — no cloud, no API keys, no internet required at runtime. The user provides a GGUF model file; the app handles everything else.

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Desktop shell | Tauri v2 | Rust backend, ~5MB overhead |
| Frontend | React + TypeScript + Vite | Tailwind v4 + shadcn/ui (Radix + Vega preset) |
| Agent framework | Vercel Eve v0.13.5 | Filesystem-first agents |
| Agent SDK | AI SDK v6 | `ai` package |
| Local HTTP server | Elysia v1.4.29 | Bun-native, sidecar process |
| LLM inference | llama-server (llama.cpp b9785) | Spawned as child process, OpenAI-compatible API |
| Durability | Workflow SDK + Turso | `@workflow-worlds/turso`, libsql local SQLite |
| Config | `eve.config.json` | Stored in `%APPDATA%\eve-offline\` |
| Package manager | Bun v1.3.13 | |
| Rust | 1.95.0 | |
| Node | v24.14.1 | |

---

## Repository

- **GitHub:** https://github.com/KnextKoder/Eve-Offline
- **Local path:** `C:\Users\DELL\aside\eve offline\`
- **Dev machine:** Dell XPS 15 9510, Windows, NVIDIA RTX 3050 Ti Laptop GPU (4GB VRAM)

---

## Current Project Structure

```
eve offline/
├── agents/
│   └── base-agent/                  ← Eve agent scaffold
│       ├── agent/
│       │   ├── agent.ts             ← model config (anthropic/claude-sonnet-4.6)
│       │   ├── instructions.md      ← system prompt (currently "You are Eve...")
│       │   └── channels/
│       │       └── eve.ts           ← channel config (not used in offline mode)
│       ├── package.json
│       └── tsconfig.json
│
├── models/
│   └── qwen2.5-0.5b-instruct-q4_k_m.gguf   ← 468MB test model
│
├── scripts/
│   └── download-llama.ps1           ← downloads llama.cpp binaries
│
├── sidecar/
│   ├── index.ts                     ← Elysia server, spawns llama-server
│   └── config.ts                    ← reads/writes eve.config.json
│
├── src/                             ← React frontend (untouched boilerplate)
│   ├── App.tsx
│   ├── main.tsx
│   └── components/ui/button.tsx     ← shadcn Button component
│
├── src-tauri/
│   ├── binaries/
│   │   ├── win-x64/
│   │   │   ├── cpu/                 ← llama.cpp CPU build (full DLL set)
│   │   │   ├── vulkan/              ← llama.cpp Vulkan build (full DLL set)
│   │   │   └── cuda/                ← llama.cpp CUDA 12.4 build + cudart DLLs
│   │   ├── mac-arm64/               ← llama.cpp macOS Apple Silicon (Metal)
│   │   ├── mac-x64/                 ← llama.cpp macOS Intel
│   │   └── linux-x64/               ← llama.cpp Linux CPU + Vulkan
│   │   └── bun-x86_64-pc-windows-msvc.exe      ← Bun v1.3.13 runtime (gitignored)
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs
│   └── tauri.conf.json
│
├── workflow.config.ts               ← DELETED (inlined into sidecar)
├── eve.config.json                  ← NOT here — lives in %APPDATA%\eve-offline\
├── eve-offline.db                   ← Workflow SDK SQLite (may be abandoned)
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

## What's Working

### ✅ Full inference chain (confirmed end-to-end)

```
POST /agents/base/run
      ↓
Elysia sidecar (port 3799)
      ↓  reads
agents/base/agent/instructions.md → system prompt
      ↓  POST /v1/chat/completions
llama-server.exe (port 8080, CUDA backend, RTX 3050 Ti)
      ↓
Response: "I am Eve, an offline AI assistant running locally on your machine."
```

### ✅ GPU auto-detection
- `nvidia-smi` detected → CUDA binary selected
- Falls back to Vulkan, then CPU
- llama-server spawned from `src-tauri/binaries/win-x64/cuda/`

### ✅ Config system
- `eve.config.json` stored at `%APPDATA%\eve-offline\eve.config.json`
- Shape: `{ "modelPath": "...", "port": 3799 }`
- Read on sidecar startup; exposed via `GET /config` and `POST /config`
- **Critical:** must be written without BOM — use `[System.IO.File]::WriteAllText()` not PowerShell `-Encoding utf8`

### ✅ Tauri integration — sidecar lifecycle managed by Rust
- `bun tauri dev` works, window opens
- `bun.exe` shipped as Tauri `externalBin` (`binaries/bun-x86_64-pc-windows-msvc.exe`)
- `sidecar/` directory bundled as a Tauri resource
- Rust (`lib.rs`) spawns `bun sidecar/index.ts` on app start
- Sidecar stdout/stderr piped to Rust console via `CommandEvent`
- Sidecar killed cleanly on window close
- No compiled sidecar binary needed — eliminates the `@libsql/client` WASM crash

---

## Sidecar: Current `sidecar/index.ts` (key parts)

**Path resolution** — Rust sets `EVE_RESOURCE_DIR` to the project root (dev) or bundled resource dir (prod):
```typescript
import { createWorld } from "@workflow-worlds/turso";
createWorld({ databaseUrl: "file:eve-offline.db" });

// Rust sets EVE_RESOURCE_DIR to the project root (dev) or bundled resource dir (prod).
const BASE_DIR: string = process.env.EVE_RESOURCE_DIR ?? process.cwd();
```

**Agent runner** uses Workflow SDK `"use workflow"` / `"use step"` for durable execution:
```typescript
async function runAgent(agentName: string, message: string) {
  "use workflow";
  const instructions = await readInstructions(agentName);
  const response = await callLlama(instructions, message);
  return response;
}

async function readInstructions(agentName: string) {
  "use step";
  // BASE_DIR resolves correctly in both dev and production
  const instructionsPath = path.join(BASE_DIR, "agents", agentName, "agent", "instructions.md");
  return await fs.readFile(instructionsPath, "utf-8");
}
```

---

## `sidecar/config.ts`

```typescript
import fs from "fs/promises";
import path from "path";
import os from "os";

export interface AppConfig {
  modelPath: string | null;
  port: number;
}

const defaultConfig: AppConfig = {
  modelPath: null,
  port: 3799,
};

function getConfigDir(): string {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === "win32") return path.join(process.env.APPDATA ?? home, "eve-offline");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "eve-offline");
  return path.join(home, ".config", "eve-offline");
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "eve.config.json");
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf-8");
    return { ...defaultConfig, ...JSON.parse(raw) };
  } catch {
    return defaultConfig;
  }
}

export async function saveConfig(config: Partial<AppConfig>): Promise<void> {
  const configDir = getConfigDir();
  await fs.mkdir(configDir, { recursive: true });
phases  const existing = await loadConfig();
  await fs.writeFile(getConfigPath(), JSON.stringify({ ...existing, ...config }, null, 2));
}
```

---

## `tauri.conf.json` (current)

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "eve-offline",
  "version": "0.1.0",
  "identifier": "com.eve.offline",
  "build": {
    "beforeDevCommand": "bun run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "bun run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{ "title": "eve-offline", "width": 800, "height": 600 }],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "resources": {
      "binaries/win-x64/cpu/*": "win-x64/cpu/",
      "binaries/win-x64/vulkan/*": "win-x64/vulkan/",
      "binaries/win-x64/cuda/*": "win-x64/cuda/"
    },
    "icon": [
      "icons/32x32.png", "icons/128x128.png",
      "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"
    ]
  }
}
```

**Note:** Mac/Linux resource entries must be added in their respective CI build environments — Tauri validates glob patterns at build time on the current platform and will error if the files don't exist locally.

---

## llama.cpp Binaries

**Version:** b9785  
**Location:** `src-tauri/binaries/`  
**Gitignored:** yes (too large for GitHub)

| Platform | Folder | Contents |
|---|---|---|
| Windows CPU | `win-x64/cpu/` | Full DLL set + llama-server.exe |
| Windows Vulkan | `win-x64/vulkan/` | CPU DLLs + ggml-vulkan.dll (46MB) |
| Windows CUDA | `win-x64/cuda/` | CUDA DLLs + ggml-cuda.dll (539MB) + cudart64_12.dll |
| macOS Apple Silicon | `mac-arm64/` | dylibs + llama-server (Metal built in) |
| macOS Intel | `mac-x64/` | dylibs + llama-server |
| Linux x64 | `linux-x64/` | .so libs + llama-server (CPU + Vulkan combined) |

**Important:** llama-server.exe is a stub launcher (0 bytes). Real logic is in `llama-server-impl.dll` (8.9MB). Both must be present alongside the full DLL set. Run `llama-server` from its own directory (`cwd: path.dirname(binary)`) so Windows can resolve DLL paths.

**CUDA note:** Two separate zips needed:
- `llama-b9785-bin-win-cuda-12.4-x64.zip` — the server binary
- `cudart-llama-bin-win-cuda-12.4-x64.zip` — CUDA runtime DLLs

**macOS/Linux extraction on Windows:** tar produces symlink errors (`.dylib`, `.so` versioned symlinks) — harmless, the versioned files land correctly and work fine.

---

## ~~Pending Decision: Durability~~ — RESOLVED ✅

The Workflow SDK (`workflow` + `@workflow-worlds/turso`) was crashing in compiled binaries because `@libsql/client` uses native WASM bindings incompatible with `bun build --compile`.

**Resolution:** Stop compiling the sidecar. Ship `bun.exe` (v1.3.13) as a Tauri `externalBin` and invoke `sidecar/index.ts` directly. The Workflow SDK runs unmodified with full durability semantics.

- No code changes to the Workflow SDK usage
- `"use workflow"` and `"use step"` directives work as designed
- `bun-x86_64-pc-windows-msvc.exe` lives in `src-tauri/binaries/` (gitignored)
- One-time setup: download bun.exe (see Dev Commands)

---

## Hard-Won Lessons

### Windows-specific
- **Spaces in paths** break `eve init` via Node `child_process` shell escaping. Workaround: run `bunx eve@latest init <name>` from a parent directory without spaces, then move the folder.
- **PowerShell `-Encoding utf8`** adds a BOM that breaks `JSON.parse`. Always use `[System.IO.File]::WriteAllText()` for writing JSON config files.
- **`curl` in PowerShell** is actually `Invoke-WebRequest` with different syntax. Use `Invoke-WebRequest -Uri ... -Method POST -ContentType ... -Body ... -UseBasicParsing`.
- **Tauri resource globs** are validated at build time on the current platform. Don't include Mac/Linux resource entries in `tauri.conf.json` when building on Windows.

### llama.cpp
- `cudart-llama-bin-win-cuda-*.zip` contains only CUDA runtime DLLs — NOT the server binary. The server binary is in `llama-b9785-bin-win-cuda-12.4-x64.zip` (separate download).
- llama-server.exe is a stub (0 bytes). The impl is in `llama-server-impl.dll`. Never try to copy just the .exe.
- Must run llama-server from its own directory so DLL resolution works.
- `-ngl 99` offloads all model layers to GPU. Omitting it means CPU-only inference even on NVIDIA hardware.

### Bun compile / Tauri sidecar
- `node-llama-cpp` cannot be compiled with `bun build --compile` — it dynamically imports platform-specific binary packages for all platforms, which the bundler tries to resolve and fails.
- `@libsql/client` (used by `@workflow-worlds/turso`) also fails in compiled binaries due to native WASM bindings. **Solution:** don't compile — ship `bun.exe` as a Tauri `externalBin` instead.
- **Windows blocks downloaded exes** — after copying `bun.exe` from a zip, run `Unblock-File src-tauri\binaries\bun-x86_64-pc-windows-msvc.exe` or the Tauri build script will get `Access is denied`.
- **`import.meta.dir` is Bun-only** — TypeScript doesn't type it on `ImportMeta`. Use `process.env.EVE_RESOURCE_DIR` (set by Rust) instead.
- **`cargo check` while app is running** fails with `Access is denied` on `bun.exe` because the running sidecar holds a lock on it. Stop the app first.
- **PowerShell `cargo check 2>&1` exits 1** even on success — cargo writes `Checking ...` progress to stderr, which PowerShell treats as an error stream. The actual result is in the `Finished` line.
- **`tauri-plugin-shell` sidecar stdout** is delivered via `CommandEvent::Stdout(line)` / `CommandEvent::Stderr(line)` on the `Receiver` returned by `.spawn()`. Pipe in a `tauri::async_runtime::spawn` task.
- **Dev vs prod path resolution** — in dev, `resource_dir()` points to `src-tauri/`. Navigate up from `current_exe()` (3 parents) to reach the project root. Use `#[cfg(debug_assertions)]` to switch. Pass the resolved root as `EVE_RESOURCE_DIR` env var to bun.
- **Rust borrow checker (E0597)** — `window.state::<T>()` returns a `State<'_, T>` that borrows `window`. Don't bind it to a named variable; inline the call so the temporary drops at the statement's semicolon.

### Eve agent structure
- Eve init fails on Windows with "Project name can only contain..." when run from a directory with spaces. Run from a clean path.
- Eve's internal `bun install` step also fails on Windows via Node child_process. Workaround: run init from a clean path, then `bun install` manually in the created folder.
- Agent folder structure after init: `<name>/agent/agent.ts`, `<name>/agent/instructions.md`, `<name>/agent/channels/eve.ts`
- For offline use, `channels/eve.ts` auth config is bypassed — agents are called directly via the sidecar, not through Eve's channel system.

---

## Roadmap

### Phase 1 — Core agent runtime ✅ COMPLETE
- [x] llama-server spawned and running via CUDA
- [x] `/agents/:name/run` endpoint reads `instructions.md` as system prompt
- [x] Config-driven model path via `eve.config.json`

### Phase 2 — Tauri integration ✅ COMPLETE
- [x] Ship `bun.exe` as Tauri `externalBin` (bypasses WASM compile issue, keeps Workflow SDK)
- [x] Register sidecar script as Tauri resource (`sidecar/` bundled)
- [x] Spawn sidecar from Rust on app launch (`src-tauri/src/lib.rs`)
- [x] Pipe sidecar stdout/stderr to Rust console via `CommandEvent`
- [x] Kill sidecar on window close
- [ ] Health check before showing UI — hold splash until port 3799 responds
- [ ] Dynamic port via Tauri events (currently hardcoded 3799)

### Phase 3 — UI
- [ ] Model file picker (Tauri `dialog` plugin → `.gguf` filter)
- [ ] Agent manager (list, create, edit agents — reads/writes `agents/` dir)
- [ ] Chat interface with streaming (SSE from Elysia)
- [ ] Run history panel (reads from `bun:sqlite` run store)

### Phase 4 — Polish
- [ ] GPU info shown in UI
- [ ] Model loading progress indicator
- [ ] Context window indicator in chat
- [ ] Settings panel
- [ ] CUDA binary download (622MB — was skipped, currently only CPU + Vulkan + CUDA in binaries but no CI automation yet)
- [ ] CI/CD: platform-specific Tauri configs for Mac/Linux builds

---

## Dev Commands

```powershell
# Start sidecar (dev)
bun run sidecar

# Start full Tauri app (dev)
bun tauri dev

# [ONE-TIME SETUP] Download bun.exe for Tauri sidecar
# Run this once after cloning, or when bun version changes
Invoke-WebRequest -Uri "https://github.com/oven-sh/bun/releases/download/bun-v1.3.13/bun-windows-x64.zip" -OutFile "$env:TEMP\bun.zip" -UseBasicParsing
Expand-Archive "$env:TEMP\bun.zip" -DestinationPath "$env:TEMP\bun-extracted" -Force
Copy-Item "$env:TEMP\bun-extracted\bun-windows-x64\bun.exe" "src-tauri\binaries\bun-x86_64-pc-windows-msvc.exe"

# Test agent endpoint
Invoke-WebRequest -Uri "http://localhost:3799/agents/base/run" -Method POST -ContentType "application/json" -Body '{"message": "Hello"}' -UseBasicParsing

# Test health
Invoke-WebRequest -Uri "http://localhost:3799/health" -UseBasicParsing

# Write config without BOM
[System.IO.File]::WriteAllText("$env:APPDATA\eve-offline\eve.config.json", '{"modelPath":"C:\\Users\\DELL\\aside\\eve offline\\models\\qwen2.5-0.5b-instruct-q4_k_m.gguf","port":3799}')
```

---

## Installed Packages (root)

```
ai, eve, workflow, @workflow-worlds/turso, elysia, @libsql/client, zustand
@ai-sdk/anthropic (in base-agent)
tailwindcss, @tailwindcss/vite
@tauri-apps/api, @tauri-apps/plugin-opener
@tauri-apps/cli, @vitejs/plugin-react, vite, typescript
@types/react, @types/react-dom, @types/node
react, react-dom
```

**Note:** `node-llama-cpp` was installed then removed. `zustand` was kept but not yet used.


```powershell
# Lists all files in the project directory except node_modules, dist, public, .vscode, src-tauri\target, and src-tauri\icons
Get-ChildItem -Recurse -Name | Where-Object { $_ -notmatch '^(node_modules|dist|public|.vscode|src-tauri\\target|src-tauri\\icons)\\' }
```