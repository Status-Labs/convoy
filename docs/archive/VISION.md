# Agent Platform: Vision & Design Notes

> Status: **archived 2026-10-24.** Long-term concept, not the current plan. See [PLAN.md](../../PLAN.md) for what we are building now.

## 1. Summary

An open source, Rust-based, self-hostable platform for running **durable AI agents**, with just enough cloud primitives around them (functions, sandboxes, storage, databases) to be a complete home for agent workloads.

The same platform can run three ways:
- on a company's own bare metal
- on cloud provider infrastructure (AWS/GCP/Azure/Hetzner…)
- as our hosted version

**Positioning: agent-first.** We are *not* "self-hosted AWS in Rust". That path leads to OpenStack-style sprawl. Cloud primitives exist to serve agents.

## 2. Target users: developers adopt it, platform teams buy it

| | Agent developers (bottom-up) | Platform teams (top-down) |
|---|---|---|
| How they find us | GitHub, `curl \| sh`, a demo that works in 5 minutes | "Our devs already use it, can we run it properly?" |
| What they need | Great SDKs, local development, replay debugging | HA cluster, SSO/RBAC, audit logs, bare metal, quotas, cost controls |
| Edition | Open source, single binary | Open source cluster plus paid enterprise features or hosted |

**Rule:** the single binary and the cluster use the same API and code paths. A developer's local project must deploy unchanged to the company cluster.

## 3. Prior art

- **Oxide (Omicron)**: Rust control plane for bare-metal racks; public code and RFDs.
- **Fly.io**: Firecracker microVMs, global proxy, WireGuard. Their blog is a strong guide to what goes wrong.
- **Restate / Temporal / Cloudflare Durable Objects**: durable execution, actor-with-state models (Restate is Rust).
- **Firecracker / Cloud Hypervisor / rust-vmm**: embeddable Rust virtual-machine monitors.
- **Garage, RustFS, MinIO, SeaweedFS**: S3-compatible object stores. Study them for design lessons; we build our own (§6.1).
- **componentize-py, ComponentizeJS / jco, StarlingMonkey**: toolchains that compile Python and JS/TS into Wasm components.
- **Neon**: separates Postgres storage from compute, in Rust.
- **Spin / wasmtime**: Rust-native WebAssembly functions.
- **OpenStack**: the warning about breadth.

## 4. Durable agents: the differentiator

Generic clouds treat agents as "a container that calls an LLM". We provide:

- **Agent = durable actor.** Stable identity, mailbox, its own SQLite state, scheduled alarms. Sleeps for free and wakes on events.
- **Journaled execution.** Every LLM call, tool call and side effect is journaled. Crashes resume mid-run; replays reuse cached LLM responses, so retries don't burn tokens.
- **Sandboxes on demand.** A Firecracker microVM in about 100 ms. Snapshot and fork to explore branches in parallel, then keep the winner.
- **Human-in-the-loop as a primitive.** Pause for days waiting on approval at no compute cost.
- **Secrets broker.** The agent never sees raw credentials; the platform injects them at the egress or tool boundary (defense against prompt injection).
- **Model gateway.** Routes to Anthropic, OpenAI or local vLLM/llama.cpp, with per-agent token budgets, rate limits and fallback.
- **MCP-native tool registry.** Any deployed function is automatically an MCP tool; agents discover tools by policy.
- **Time-travel debugging.** Replay any run step by step from its journal; fork from step N with a changed prompt.
- **Egress policy per agent.** Allowlisted domains, all traffic logged.

## 5. Architecture

### 5.1 Overview

```
                   ┌─────────────────────────────────────────┐
  API / CLI / UI → │ Control plane (Rust)                    │
                   │  • Raft state store (openraft + redb)   │
                   │  • Declarative API + reconcilers        │
                   │  • Scheduler, IAM, metering             │
                   └──────────────┬──────────────────────────┘
                                  │ gRPC (tonic) over WireGuard mesh
        ┌─────────────────────────┼─────────────────────────┐
   ┌────▼────┐               ┌────▼────┐               ┌────▼────┐
   │ Node    │  each node runs one agent daemon:            │
   │ agent   │   • Wasm runtime (wasmtime)    – functions   │
   │         │   • microVMs (Firecracker/CH)  – sandboxes, containers
   │         │   • eBPF networking (aya)      – tenant isolation
   │         │   • local NVMe + object/storage shard        │
   └─────────┘                                              │
         Edge: Pingora-based ingress/LB, TLS (rustls), ACME
```

### 5.2 Agents are TypeScript/Python compiled to Wasm

Agent developers write TypeScript and Python. The CLI compiles their code into **Wasm components** (via ComponentizeJS/jco and componentize-py), and the Rust runtime runs them in-process with wasmtime. The SDK is a thin wrapper over a WIT interface that the runtime implements as host functions:

```
  agent.ts / agent.py
        │  `ap build` (jco / componentize-py)
        ▼
  agent.wasm (Wasm component, imports our WIT world)
        │
┌───────▼──────────── Rust runtime (wasmtime, in-process) ─────────────┐
│  host functions: llm · tool · sleep · approve · send · state · sandbox │
│  journal · per-instance SQLite · model gateway · secrets · timers      │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ ctx.sandbox() only
                            ▼
                Firecracker microVM (arbitrary code, native deps)
```

**Why Wasm for agents:**
- **Density and cost.** Thousands of agent instances per node; cold start in milliseconds; idle agents cost nothing.
- **Determinism and replay.** The only way out of the guest is through our host functions, so every non-deterministic input (time, randomness, network, LLM output) is captured in the journal. Replay is exact by construction rather than by SDK discipline.
- **Isolation.** Capability-based: an agent can only call what its WIT world and policy grant. No ambient network or filesystem access.
- **Suspend/resume.** Instance memory can potentially be snapshotted, enabling fast resume and fork without replaying from the start.
- **One artifact everywhere.** The same `.wasm` runs on a laptop, a bare-metal cluster or the hosted version.

**Known limits and mitigations:**
- **Native extensions** (numpy, pandas, many PyPI packages) don't work in componentize-py, and Node built-ins are limited in StarlingMonkey. Mitigation: heavy or native work goes through `ctx.sandbox()` (Firecracker), which is already in the SDK. The pure-Python/JS agent loop stays in Wasm.
- **Bundle size and startup** for Python components (embedded interpreter). Mitigation: pre-initialization (Wizer-style) and caching compiled modules per node.
- **Async model.** Relies on WASI P3 / component-model async maturing; track upstream closely and contribute where needed.
- **Debugging.** Source maps and stack traces back to TS/Python must be good, or developers will bounce.
- **Escape hatch.** Keep the option to run an agent as a native process in a microVM over the same WIT-defined protocol (as a socket transport) for code that can't compile to Wasm.

### 5.3 SDK sketch

```ts
import { agent } from "@yourplatform/sdk";

export default agent("support-triage", {
  state: { tickets: [] as string[] },

  async onMessage(ctx, msg) {
    const plan = await ctx.llm({            // journaled; replay won't re-bill
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: msg.text }],
      tools: ctx.tools("crm.*", "kb.search"),  // MCP tools, policy-filtered
    });

    if (plan.needsRefund) {
      const ok = await ctx.approve("refund", { amount: plan.amount }); // pauses for days, zero compute
      if (!ok) return;
    }

    const box = await ctx.sandbox("python:3.13");  // Firecracker, ~100ms
    const report = await box.run("analyze.py", { data: plan.data });

    ctx.state.tickets.push(msg.id);          // SQLite-backed, transactional with journal
    await ctx.sleep("24h");                  // durable timer
    await ctx.send("followup-agent", { id: msg.id });
  },
});
```

### 5.4 Core data model

```
AgentType      code + config + policies (versioned deploys)
AgentInstance  identity (e.g. "support-triage/customer-123"), mailbox, SQLite state
Run            one invocation; has a journal of Steps
Step           llm_call | tool_call | sandbox_exec | sleep | approval | send | state_write
Policy         model allowlist, token budget, egress domains, tool scopes, secret bindings
Sandbox        microVM with snapshot/fork lineage
```

### 5.5 Journal storage (the most important internal decision)

Partitioned log keyed by hash of the agent instance ID:
- single-node mode: one partition per log, local storage
- cluster mode: one Raft group per partition
- snapshots and compaction to S3

The same abstraction scales from a laptop to a cluster.

## 6. Platform primitives, ordered by return on effort

| Primitive | Approach | Difficulty |
|---|---|---|
| **Functions** | Wasm components (WASI P2/P3), cold starts under 1 ms; container-image functions on Firecracker with snapshot restore | Medium |
| **Durable agents** ⭐ | See §4 | Medium–High |
| **Object storage** ⭐ | Our own storage engine with an S3-compatible API (see §6.1) | High |
| **KV / per-tenant SQL** | SQLite (or libSQL) per agent or tenant, replicated (Durable Objects model) | Medium |
| **Managed Postgres** | Orchestrate vanilla Postgres: replication, backups to our object store, point-in-time recovery. **Don't write a database.** | Medium |
| **Compute (VMs/containers)** | Cloud Hypervisor or Firecracker plus OCI images | Medium |
| **Networking (VPCs, private networks)** | WireGuard overlay plus eBPF policy; multi-tenant isolation is a hard problem | **High** |
| **Block storage** | Start with local NVMe plus snapshots to S3; integrate Ceph if customers demand replicated block storage | **Very high** |
| **IAM, quotas, billing** | Required before any hosted or multi-tenant offering | High |

### 6.1 Object storage: our own engine, S3-compatible API

We build our own object storage rather than embedding Garage/MinIO. The **S3 API is the adoption surface**: existing SDKs, CLIs (aws, rclone), backup tools and data tooling work unchanged.

**Why build it ourselves:**
- It underpins nearly everything else: journal snapshots, sandbox/VM snapshots, Wasm artifacts, Postgres backups, agent files, user data. Owning it lets us tune for those workloads.
- Tight integration with platform IAM, policies, metering and the secrets broker (e.g. agents get scoped, short-lived access without seeing keys).
- Agent-specific features that generic S3 stores don't offer (below).
- Strategic control: no dependency on another project's license or roadmap (MinIO's license and feature changes are a cautionary example).

**Design sketch:**
- **Metadata:** Raft-replicated metadata store (shares control-plane building blocks: openraft + redb), sharded by bucket/prefix.
- **Data:** content-addressed chunks on local NVMe/HDD; erasure coding (e.g. Reed-Solomon) for durability across nodes/racks; replication for small objects.
- **Single-node mode:** same API backed by a local directory, so Phase 0 and laptops get it for free.
- **Tiering:** optional backends behind a trait for offloading cold data to a cloud provider's S3/GCS/Azure Blob.
- **Async I/O:** io_uring (tokio-uring/glommio-style) on Linux for throughput.

**Differentiating features (beyond plain S3):**
- **Cheap snapshots and forks of buckets/prefixes** (copy-on-write, enabled by content addressing). Pairs with agent fork-from-step: fork the agent *and* its files.
- **Dedup across sandbox/VM snapshots** via content addressing, which keeps snapshot-heavy agent workloads cheap.
- **Event notifications** that wake agents directly (object created → agent mailbox).
- **Per-agent scoped credentials** issued by the platform, audit-logged.

**S3 compatibility scope:** target the commonly used subset first (buckets, Put/Get/Head/Delete, List v2, multipart upload, presigned URLs, SigV4, ranges, conditional requests, versioning). Defer rarely used features (Select, Glacier semantics, full ACL model). Run an S3 conformance suite (e.g. ceph/s3-tests) in CI.

**Risk:** durable distributed storage is one of the hardest things on this list. Durability bugs lose customer data. Budget for fault-injection testing (deterministic simulation, Jepsen-style) from the start, and give it a dedicated owner.

> Open: "proprietary" here means *built in-house*. Decide whether the storage engine is part of the open source core (likely needed for self-hosting) or partly under the commercial license (e.g. erasure coding / multi-site replication as enterprise features).

## 7. Running anywhere

1. **Cloud as dumb hardware (recommended).** Provision VMs or metal instances and run our own stack on them, so it behaves the same everywhere. Firecracker needs KVM: bare-metal instances or nested virtualization (verify per provider). Without KVM, fall back to Wasm-only, or gVisor for sandboxes.
2. **Map primitives to native services** (S3, RDS…). Only as optional storage backends behind traits (`object_store` / OpenDAL), because it multiplies the test matrix.

**Bare metal:** eventually PXE/iPXE provisioning, an immutable host OS and a fleet upgrade story. Support a narrow hardware list at first.

**Kubernetes:** build our own lean orchestrator (closer to Nomad), since microVMs plus Wasm plus durable actors don't map cleanly onto k8s. Later, add an "install on existing k8s" mode for enterprises.

## 8. Roadmap

### Phase 0: single binary (about 4–6 months)

**In:**
- Durable agent runtime: journal, mailbox, timers, approvals, per-instance SQLite
- TypeScript and Python SDKs compiled to Wasm components; WIT interface for the host API; replay and versioning semantics
- Model gateway: Anthropic, OpenAI, OpenAI-compatible/local; budgets; response caching for replay
- MCP tool registry plus Wasm functions as tools
- Object storage, single-node mode: S3-compatible API over local disk (same engine interfaces as the distributed version)
- Firecracker sandboxes with snapshot and fork (Linux; Docker fallback on Mac)
- Secrets broker plus egress allowlist
- CLI (`init`, `dev`, `deploy`, `logs`, `replay`) and a web UI with run timelines, time-travel and fork-from-step

**Deliberately out:** clustering, VMs, Postgres, multi-tenancy, bare metal. Keep the interfaces ready for them, but don't build them.

**The demo:** an agent crashes mid-task, resumes without re-billing tokens, and we then fork from step 7 with a fixed prompt in the UI.

### Phase 1: cluster
Raft control plane, journal partitions spread across nodes, scheduler, Pingora ingress, SSO/RBAC, audit log, distributed object storage (replication first, erasure coding next). The first thing platform teams will pay for.

### Phase 2: a "real cloud"
Object storage hardening (erasure coding, multi-site replication, tiering), managed Postgres, bare-metal provisioning, quotas and chargeback per team, hosted beta.

### Phase 3
VMs, cloud adapters, multi-region, block storage if demand is real.

## 9. Team split (about 6–7 engineers)

1. **Runtime core:** journal, partitions, state, timers, the replay engine, wasmtime host functions. Strongest systems engineer.
2. **Sandbox and node:** Firecracker integration, snapshots and forking, egress control, the Docker fallback.
3. **Gateway and tools:** model gateway, MCP registry, Wasm functions, secrets broker.
4. **SDKs, toolchain and DX:** WIT interface, TS/Python → Wasm build pipeline (jco, componentize-py), source maps, CLI, local dev loop. Decides whether developers adopt us.
5. **UI and observability:** run timelines, replay and fork UI, OpenTelemetry export.
6. **Object storage:** S3 API layer, storage engine, durability testing. Starts with single-node mode in Phase 0; grows into a team of its own in Phase 1.
7. **(Later) control plane:** Phase 1 design (Raft, scheduler, IAM) in parallel during the second half of Phase 0.

## 10. Rust ecosystem

tokio, tonic/axum, openraft, redb, wasmtime (+ wit-bindgen, wasm-tools), rust-vmm/firecracker, cloud-hypervisor, aya (eBPF), pingora, boringtun, rustls, object_store/opendal, sqlx, libsql, opentelemetry.

Object storage: io_uring (tokio-uring / glommio), reed-solomon-erasure (or reed-solomon-simd), blake3 (content addressing), s3s (S3 protocol server framework, worth evaluating vs. writing our own HTTP layer).

Non-Rust toolchain dependencies: jco / ComponentizeJS / StarlingMonkey (TS/JS → Wasm), componentize-py (Python → Wasm).

## 11. Main risks

- **Scope.** Each primitive is a product with its own day-2 operations (upgrades, backups, migrations).
- **Upgrading the platform itself** without downtime. Design for it from day one with versioned APIs and rolling node upgrades.
- **Object storage durability.** Building our own engine means owning data-loss risk. Requires deterministic simulation and fault-injection testing from day one.
- **Wasm toolchain maturity.** We depend on upstream JS/Python → Wasm tooling and WASI async. Package compatibility gaps (native extensions) could frustrate developers; the sandbox escape hatch must feel seamless.
- **Networking and security isolation.** A multi-tenant hosted version is held to a much higher bar than a single-company install.
- **Business model.** Open core plus hosted works (Supabase, Grafana), but the license shapes who contributes.

## 12. Open questions

- [ ] **License:** Apache-2.0 core with enterprise features under a commercial license, vs AGPL/FSL (protects the hosted offering from cloud resellers).
- [ ] **Determinism contract:** how strict replay is when users change code mid-run (versioning, like Temporal's patching).
- [ ] **WIT world for agents:** the host API is defined in WIT, so any language that compiles to a Wasm component (Rust, Go, C#…) can get an SDK. Needs careful versioning since it's our core contract.
- [ ] **Package compatibility policy:** which npm/PyPI packages we support in-Wasm, and how the toolchain detects and reports unsupported ones (suggest moving to `ctx.sandbox()`).
- [ ] **Object storage licensing:** fully open core, or enterprise-only features (erasure coding, multi-site replication)?
- [ ] **Build vs. adopt for S3 protocol layer:** use the `s3s` crate or write our own.
- [ ] **Project name.**
