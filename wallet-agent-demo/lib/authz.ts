import { getAddress, type Address } from "viem";

export type Role = "user" | "sandbox";
export type ToolName = "get_time" | "run_js";

// Policy as data: which role a tool requires.
const POLICY: Record<ToolName, Role> = {
  get_time: "user",
  run_js: "sandbox",
};

function loadAllowlist(): Set<Address> {
  const raw = process.env.SANDBOX_ALLOWLIST ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => getAddress(entry as Address)),
  );
}

// Parsed once at module load, but every function below re-reads it fresh
// rather than baking a role snapshot into a session at sign-in time. That's
// what makes this a "live" store: a revoked address stops passing canUse()
// on its very next tool call, mid-conversation, not just on next login.
const sandboxAllowlist = loadAllowlist();

export function rolesFor(address: Address): Role[] {
  const roles: Role[] = ["user"];
  if (sandboxAllowlist.has(getAddress(address))) roles.push("sandbox");
  return roles;
}

export function canUse(address: Address, tool: ToolName): boolean {
  const required = POLICY[tool];
  if (!required) return false; // unknown tool name: deny by default
  return rolesFor(address).includes(required);
}

export function allowedTools(address: Address): ToolName[] {
  return (Object.keys(POLICY) as ToolName[]).filter((tool) => canUse(address, tool));
}
