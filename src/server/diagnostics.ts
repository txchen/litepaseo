/** Classify untrusted SDK failures without copying URLs, credentials or remote text into logs/UI. */
export function connectionProblem(value: unknown): { code: string; message: string } {
  const e = value as { reason?: unknown; failureCode?: unknown; message?: unknown; code?: unknown } | null;
  const text = [e?.reason, e?.failureCode, e?.message, e?.code].filter(v => typeof v === "string").join(" ").toLowerCase();
  if (/password.required|password required/.test(text)) return { code: "password_required", message: "Authentication required. Add this host using a password-bearing connection URL or a pairing offer." };
  if (/incorrect.password|unauthorized|authentication|auth.failed|forbidden/.test(text)) return { code: "authentication_failed", message: "Authentication failed. Check the host credentials or create a new pairing offer." };
  if (/version|protocol|incompatible/.test(text)) return { code: "incompatible", message: "Protocol negotiation failed. Check the daemon and client versions." };
  if (/enotfound|eai_again|dns/.test(text)) return { code: "dns", message: "Host name could not be resolved. Check the address and DNS." };
  if (/econnrefused|connection refused/.test(text)) return { code: "refused", message: "Connection refused. Check that the daemon is running and the port is reachable." };
  if (/timed?.?out|timeout/.test(text)) return { code: "timeout", message: "Connection timed out. Check the network, tunnel and firewall." };
  if (/cert|tls|ssl/.test(text)) return { code: "tls", message: "Secure connection failed. Check the server certificate and TLS configuration." };
  return { code: "disconnected", message: "Connection lost. Check the daemon, network and connection settings." };
}
