/** Durable source labels survive model turns and task completion. This is an approval guard,
 * not a content classifier or a substitute for the execution sandbox. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Taint } from "./egress-taint.ts";

// These deterministic local reads and task commands cannot export data to another service.
// Unknown tools, arbitrary VM code, connectors and browser actions ask after a host read.
const LOCAL = new Set(["HostTask", "read_file", "list_dir", "search_files", "ReadKept", "SetPlan", "SetTodos", "Checkpoint", "AskUser", "WaitForControl", "HandBack", "NothingToSay"]);
export class HostDataGuard {
  private agents = new Set<string>();
  private shared = false;
  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(raw.agents) || raw.agents.some((id: unknown) => typeof id !== "string")) throw new Error("Invalid source record");
      this.agents = new Set(raw.agents); this.shared = raw.shared === true;
    } catch { this.shared = true; } // unreadable provenance never silently untaints context
  }
  mark(agentId: string): void { this.agents.add(agentId); this.save(); }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ agents: [...this.agents], shared: this.shared }), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
  private has(agentId: string): boolean { return this.shared || this.agents.has(agentId); }
  taint(call: { agentId: string; tool: string }): Taint | undefined {
    return this.has(call.agentId) && !LOCAL.has(call.tool) ? { sources: ["host"], target: call.tool, rule: "host-data" } : undefined;
  }
  allowed(call: { agentId: string; tool: string }): void {
    // Approved use outside the local task can store or forward data to another agent (Tasks,
    // memories, delegated engines, arbitrary VM code). Conservatively propagate on all such uses.
    if (this.has(call.agentId) && !LOCAL.has(call.tool) && !this.shared) { this.shared = true; this.save(); }
  }
}
