import { cookies } from "next/headers";
export { chunkText } from "./chunk-text";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
function redactSecrets(value: string) {
  let safe = value;
  for (const secret of [service, process.env.GROQ_API_KEY, process.env.EMBEDDING_API_KEY]) if (secret) safe = safe.replaceAll(secret, "[redacted]");
  return safe.replace(/(?:Bearer\s+)?(?:gsk_|sb_(?:secret|publishable|service_role)_|sk-[A-Za-z0-9_-]+)[^\s]*/gi, "[redacted]");
}

async function fetchTimed(input: string | URL, init: RequestInit = {}, timeoutMs = 45_000) {
  try { return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error(`External request timed out after ${Math.round(timeoutMs / 1000)} seconds. Check provider status and try again.`);
    throw new Error("Could not reach an external service. Check the URL and network connection, then try again.");
  }
}

export const configured = Boolean(url && anon && service);
export async function token() { return (await cookies()).get("gf_session")?.value; }
export async function auth(path: string, body: unknown) {
  if (!url || !anon) throw new Error("Configure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  const response = await fetchTimed(`${url}/auth/v1/${path}`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await response.json(); if (!response.ok) throw new Error(data.msg || data.message || data.error_description || "Authentication failed."); return data;
}
export async function db(table: string, method = "GET", query = "", body?: unknown, bearer?: string) {
  if (!url || !anon || !service) throw new Error("Supabase is not configured. Add the required environment variables and run supabase/schema.sql.");
  const response = await fetchTimed(`${url}/rest/v1/${table}${query ? `?${query}` : ""}`, { method, headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json", Prefer: method === "POST" ? "return=representation" : "return=minimal", ...(bearer ? { "X-User-Token": bearer } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store" });
  if (!response.ok) { const detail = await response.text(); throw new Error(`Database request failed (${response.status}): ${detail.slice(0, 240)}`); }
  if (response.status === 204) return null; const text = await response.text(); return text ? JSON.parse(text) : null;
}
export async function currentUser() {
  const access = await token(); if (!access || !url || !anon) return null;
  const response = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${access}` }, cache: "no-store" });
  return response.ok ? response.json() : null;
}
export async function userDb(table: string, method = "GET", query = "", body?: unknown) {
  const access = await token(); if (!access) throw new Error("Sign in to continue.");
  if (!url || !anon) throw new Error("Supabase is not configured.");
  const response = await fetchTimed(`${url}/rest/v1/${table}${query ? `?${query}` : ""}`, { method, headers: { apikey: anon, Authorization: `Bearer ${access}`, "Content-Type": "application/json", Prefer: method === "POST" ? "return=representation" : "return=minimal" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store" });
  if (!response.ok) throw new Error(`Database request failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
  if (response.status === 204) return null; const text = await response.text(); return text ? JSON.parse(text) : null;
}
export async function embedMany(texts: string[]) {
  const key = process.env.EMBEDDING_API_KEY?.trim();
  if (!key) throw new Error("Add EMBEDDING_API_KEY. Configure a compatible embedding endpoint and model before processing RAG documents.");
  const endpoint = process.env.EMBEDDING_API_URL?.trim() || "https://api.openai.com/v1/embeddings";
  const model = process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
  try { const parsed = new URL(endpoint); if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported protocol"); }
  catch { throw new Error("EMBEDDING_API_URL must be a valid absolute HTTP(S) URL ending at the provider's embeddings endpoint."); }
  const response = await fetchTimed(endpoint, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: texts }), cache: "no-store" }, 60_000);
  if (!response.ok) {
    const body = await response.text(); let reason = ""; let code = "";
    try { const parsed = JSON.parse(body); reason = redactSecrets(String(parsed.error?.message || parsed.message || "")).slice(0, 220); code = String(parsed.error?.code || parsed.error?.type || "").toLowerCase(); } catch { reason = redactSecrets(body).slice(0, 220); }
    if (response.status === 401) throw new Error("Embedding provider rejected EMBEDDING_API_KEY (HTTP 401). The configured key is invalid, revoked, or not valid for this provider. Create/activate a key at the provider configured by EMBEDDING_API_URL and replace only EMBEDDING_API_KEY in .env.local.");
    if (response.status === 403) throw new Error(`Embedding provider denied access (HTTP 403). Check the key's project permissions and embedding access.${reason ? ` Provider: ${reason}` : ""}`);
    if (response.status === 402 || code.includes("insufficient_quota") || /quota|billing|credit/i.test(reason)) throw new Error(`Embedding provider quota or billing limit reached (HTTP ${response.status}). Check the provider account's quota and billing.${reason ? ` Provider: ${reason}` : ""}`);
    if (response.status === 429) throw new Error(`Embedding provider rate limit reached (HTTP 429). Wait briefly and retry.${reason ? ` Provider: ${reason}` : ""}`);
    if (response.status === 404 && (code.includes("model") || /model.*(not found|does not exist|unavailable)/i.test(reason))) throw new Error(`Embedding model "${model}" was not found (HTTP 404). Check EMBEDDING_MODEL for this provider.${reason ? ` Provider: ${reason}` : ""}`);
    if (response.status === 404) throw new Error(`Embedding endpoint returned HTTP 404. Check that EMBEDDING_API_URL is the provider's embeddings endpoint, not its base URL.${reason ? ` Provider: ${reason}` : ""}`);
    if (response.status === 400 && (code.includes("model") || /model.*(not found|does not exist|unsupported)/i.test(reason))) throw new Error(`Embedding model "${model}" is not supported by this provider (HTTP 400). Check EMBEDDING_MODEL.${reason ? ` Provider: ${reason}` : ""}`);
    throw new Error(`Embedding provider returned HTTP ${response.status}.${reason ? ` Provider: ${reason}` : " Check the endpoint and provider status."}`);
  }
  let data: { data?: unknown };
  try { data = await response.json(); }
  catch { throw new Error("Embedding provider returned HTTP success with an invalid JSON response."); }
  if (!Array.isArray(data.data)) throw new Error("Embedding provider returned a successful response without a data array.");
  const entries = data.data as Array<{ index?: unknown; embedding?: unknown }>;
  const ordered = entries.every((item) => typeof item.index === "number") ? [...entries].sort((a, b) => Number(a.index) - Number(b.index)) : entries;
  const vectors = ordered.map((item) => item.embedding);
  if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error(`Embedding API returned ${vectors?.length || 0} vectors for ${texts.length} text chunks.`);
  if (vectors.some((v: unknown) => !Array.isArray(v) || v.length !== 1536 || v.some((x: unknown) => typeof x !== "number" || !Number.isFinite(x)))) throw new Error("Embedding model must return finite, 1,536-dimensional vectors to match the database schema.");
  return vectors as number[][];
}
export async function embed(text: string) { return (await embedMany([text]))[0]; }
export async function groq(system: string, prompt: string) {
  const key = process.env.GROQ_API_KEY; if (!key) throw new Error("Configure GROQ_API_KEY to use grounded AI features.");
  const model=process.env.GROQ_MODEL?.trim()||"openai/gpt-oss-120b";
  const response = await fetchTimed("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }), cache: "no-store" }, 60_000);
  if (!response.ok) {
    const body=await response.text();let detail="";let code="";
    try{const parsed=JSON.parse(body);detail=redactSecrets(String(parsed.error?.message||parsed.message||"")).slice(0,240);code=String(parsed.error?.code||parsed.error?.type||"")}catch{detail=redactSecrets(body).slice(0,240)}
    if(response.status===401)throw new Error("Groq rejected GROQ_API_KEY (HTTP 401). Check the key in your server environment.");
    if(response.status===403)throw new Error(`Groq denied access (HTTP 403). Check key permissions, account access, and GROQ_MODEL.${detail?` Provider: ${detail}`:""}`);
    if(response.status===404||code.toLowerCase().includes("model")||/model.*(not found|decommission|retired|unavailable)/i.test(detail))throw new Error(`Groq model "${model}" is unavailable (HTTP ${response.status}). Set GROQ_MODEL to an active model in .env.local and restart Next.js.${detail?` Provider: ${detail}`:""}`);
    if(response.status===429)throw new Error(`Groq rate limit or quota reached (HTTP 429). Wait and retry, or check your Groq plan.${detail?` Provider: ${detail}`:""}`);
    throw new Error(`Groq request failed (HTTP ${response.status}).${detail?` Provider: ${detail}`:" Check GROQ_MODEL and provider status."}`);
  }
  const data = await response.json();
  try { return JSON.parse(data.choices[0].message.content); } catch { throw new Error("AI returned an invalid response. Please try again."); }
}
export async function retrieve(query: string, userId: string, limit = 5) {
  const vector = await embed(query);
  const rows = await userDb("match_document_chunks", "POST", "", { query_embedding: vector, match_threshold: 0.25, match_count: limit, filter_user_id: userId });
  return Array.isArray(rows) ? rows.filter((r) => r.similarity >= 0.25) : [];
}
