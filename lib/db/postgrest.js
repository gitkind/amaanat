// Production adapter: Supabase PostgREST RPC using the service-role key.
// Server-side only. The key never leaves this process.
import { toDbError } from "./errors.js";

export function createPostgrestDb({ url, serviceRoleKey, fetchImpl = fetch, timeoutMs = 10000 }) {
  if (!url || !serviceRoleKey) throw new Error("Supabase URL and service-role key are required");
  const base = url.replace(/\/+$/, "");

  async function rpc(name, args = {}) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid function name: ${name}`);
    const response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: "Invalid JSON from database" };
    }
    if (!response.ok) throw toDbError(json, response.status);
    return json;
  }

  return { kind: "postgrest", rpc, close: async () => {} };
}
