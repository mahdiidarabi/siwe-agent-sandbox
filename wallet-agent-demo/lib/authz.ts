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

// TODO(audit): this comment used to claim canUse() re-reads the allowlist
// on every call, making revocation take effect "mid-conversation." That was
// false: loadAllowlist() runs exactly once, right here, at module load.
// process.env doesn't change at runtime without a restart, so revoking an
// address today means editing SANDBOX_ALLOWLIST and restarting the server,
// not the next tool call. rolesFor()/canUse() do re-check this Set on every
// call rather than trusting a snapshot baked into the session at sign-in
// time, which is what stops a role change from requiring the user to sign
// out and back in, but it's still bounded by whatever was true at process
// start.
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
