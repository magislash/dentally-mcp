import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";
import crypto from "crypto";

const DENTALLY_API = "https://api.dentally.co/v1";
const DENTALLY_RATE_URL = "https://api.dentally.co/rate_limit";
const PORT = process.env.PORT || 3000;

// Region-based token pools.
// Each region takes up to 3 tokens, rotated round-robin. Rotation only raises the
// effective rate limit if the tokens map to SEPARATE Dentally quota buckets — see
// summarisePool(), which detects a shared bucket and refuses to over-report headroom.
// Ireland tokens are used by default. UK tokens (Manchester, Leeds, Glasgow,
// Enniskillen) are used only when a tool is called with region:"uk".
// Duplicate values are collapsed: the same token pasted into two slots adds nothing.
const dedupe = (arr) => [...new Set(arr.filter(Boolean).map((t) => t.trim()).filter(Boolean))];
const TOKEN_POOLS = {
  ireland: dedupe([
    process.env.DENTALLY_API_TOKEN,
    process.env.DENTALLY_API_TOKEN_2,
    process.env.DENTALLY_API_TOKEN_3,
  ]),
  uk: dedupe([
    process.env.DENTALLY_UK_API_TOKEN,
    process.env.DENTALLY_UK_API_TOKEN_2,
    process.env.DENTALLY_UK_API_TOKEN_3,
  ]),
};

// Env var names for a region, used in error messages so the fix is actionable.
function envNamesFor(region) {
  return region === "uk"
    ? "DENTALLY_UK_API_TOKEN / _2 / _3"
    : "DENTALLY_API_TOKEN / _2 / _3";
}

// Pick the pool for a region, falling back to Ireland if UK is not configured.
function poolFor(region = "ireland") {
  const pool = TOKEN_POOLS[region];
  return pool && pool.length ? pool : TOKEN_POOLS.ireland;
}

const tokenIndex = { ireland: 0, uk: 0 };
function getNextToken(region = "ireland") {
  const pool = poolFor(region);
  const t = pool[tokenIndex[region] % pool.length];
  tokenIndex[region]++;
  return t;
}

async function dentallyPage(path, region = "ireland") {
  const pool = poolFor(region);
  const activeToken = getNextToken(region);
  const res = await fetch(`${DENTALLY_API}${path}`, {
    headers: { Authorization: `Bearer ${activeToken}`, "Content-Type": "application/json", "User-Agent": "Dentally-MCP-Server v3" },
  });
  if (res.status === 401 || res.status === 403) throw new Error(authFailureMessage(region, res.status));
  if (res.status === 429) {
    // Current token exhausted — try another token in the same region's pool if available
    if (pool.length > 1) {
      const fallbackToken = getNextToken(region);
      const res2 = await fetch(`${DENTALLY_API}${path}`, {
        headers: { Authorization: `Bearer ${fallbackToken}`, "Content-Type": "application/json", "User-Agent": "Dentally-MCP-Server v3" },
      });
      if (res2.status === 401 || res2.status === 403) throw new Error(authFailureMessage(region, res2.status));
      if (!res2.ok) throw new Error(`Dentally API error: ${res2.status} ${res2.statusText}`);
      return res2.json();
    }
    const retry = res.headers.get("Retry-After") || "60";
    throw new Error(`🚫 RATE LIMIT HIT — All ${region} tokens exhausted. Please wait ${retry} seconds.`);
  }
  if (!res.ok) throw new Error(`Dentally API error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function dentallyAll(endpoint, params = {}, key, region = "ireland") {
  let page = 1, allItems = [];
  while (true) {
    const qp = new URLSearchParams({ ...params, per_page: 100, page }).toString();
    const data = await dentallyPage(`${endpoint}?${qp}`, region);
    const items = data[key] || [];
    allItems = allItems.concat(items);
    const meta = data.meta || {};
    const total = meta.total_count || meta.total || 0;
    if (allItems.length >= total || items.length === 0) break;
    page++;
  }
  return allItems;
}

function localeFor(region) { return region === "uk" ? "en-GB" : "en-IE"; }

// A token was rejected outright. Never report this as a rate limit — that conflation
// is what made an expired-token outage look like an exhausted quota.
function authFailureMessage(region, status) {
  return `🔑 DENTALLY AUTH FAILED (${region}, HTTP ${status}) — the token was rejected. ` +
    `It is invalid, expired, or revoked. This is NOT a rate limit and will not fix itself. ` +
    `Regenerate the App Token in Dentally and update ${envNamesFor(region)} in the Render environment.`;
}

// Read one token's quota. Distinguishes auth failure / HTTP error / unreachable from
// a real "0 remaining", all of which the old code flattened into remaining:0.
async function readRateLimit(token) {
  try {
    const res = await fetch(DENTALLY_RATE_URL, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Dentally-MCP-Server v3" },
    });
    if (res.status === 401 || res.status === 403) return { authError: true, status: res.status };
    if (!res.ok) return { httpError: `HTTP ${res.status}` };
    const data = await res.json();
    const core = data.resources?.core;
    if (!core || typeof core.remaining !== "number") return { httpError: "no rate_limit payload" };
    return { remaining: core.remaining, limit: core.limit ?? 0, reset: core.reset ?? 0 };
  } catch (e) {
    return { netError: String(e?.message || e) };
  }
}

// Combine a pool's readings. Tokens reporting an identical bucket (same limit, reset
// and remaining) are sharing ONE server-side quota, so summing them would overstate
// headroom — count each distinct bucket once instead.
function summarisePool(results) {
  const live = results.filter((r) => typeof r.remaining === "number");
  const authFailed = results.length > 0 && results.every((r) => r.authError);
  if (!live.length) return { usable: false, authFailed, remaining: 0, limit: 0, reset: 0, shared: false };
  const key = (r) => `${r.limit}:${r.reset}:${r.remaining}`;
  const buckets = [...new Map(live.map((r) => [key(r), r])).values()];
  return {
    usable: true,
    authFailed: false,
    remaining: buckets.reduce((sum, r) => sum + r.remaining, 0),
    limit: buckets.reduce((sum, r) => sum + r.limit, 0),
    reset: Math.min(...live.map((r) => r.reset)),
    shared: buckets.length === 1 && live.length > 1,
    bucketCount: buckets.length,
  };
}

function poolBreakdown(results) {
  return results
    .map((r, i) => {
      if (r.authError) return `Token ${i + 1}: AUTH FAILED`;
      if (typeof r.remaining === "number") return `Token ${i + 1}: ${r.remaining}/${r.limit}`;
      return `Token ${i + 1}: unavailable`;
    })
    .join(" | ");
}

async function checkRateLimit(region = "ireland") {
  try {
    const pool = poolFor(region);
    const results = await Promise.all(pool.map((t) => readRateLimit(t)));
    const s = summarisePool(results);
    const breakdown = poolBreakdown(results);

    if (s.authFailed) return { ok: false, warning: `${authFailureMessage(region, 401)} [${breakdown}]` };
    // Could not read the quota (network blip, unexpected payload) — don't block the query.
    if (!s.usable) return { ok: true, warning: null };

    const resetTime = new Date(s.reset * 1000).toLocaleTimeString(localeFor(region), { hour: "2-digit", minute: "2-digit" });
    const pct = s.limit ? Math.round((s.remaining / s.limit) * 100) : 0;
    const sharedNote = s.shared ? ` NOTE: these ${results.length} tokens share ONE ${s.limit}/hr quota — they do not multiply it.` : "";

    if (s.remaining === 0) return { ok: false, warning: `🚫 RATE LIMIT EXHAUSTED (${region}) — 0/${s.limit} remaining. Resets at ${resetTime}.${sharedNote}` };
    if (s.remaining < 200) return { ok: true, warning: `⚠️ Rate limit CRITICAL (${region}): ${s.remaining}/${s.limit} remaining (${pct}%). ${breakdown}. Resets at ${resetTime}.${sharedNote}` };
    if (s.remaining < 600) return { ok: true, warning: `⚠️ Rate limit LOW (${region}): ${s.remaining}/${s.limit} remaining (${pct}%). ${breakdown}${sharedNote}` };
    return { ok: true, warning: null, remaining: s.remaining, limit: s.limit, footer: `🟢 API (${region}): ${s.remaining}/${s.limit} requests left (resets ${resetTime})${sharedNote}` };
  } catch {
    return { ok: true, warning: null };
  }
}

function rlFooter(rl) {
  if (!rl) return "";
  if (!rl.ok) return `\n\n🚫 API: 0 requests left — rate limit exhausted`;
  if (rl.warning) return `\n\n${rl.warning}`;
  if (rl.footer) return `\n\n${rl.footer}`;
  return "";
}

// Region-aware currency: € for Ireland, £ for UK.
function money(val, region = "ireland") { const sym = region === "uk" ? "£" : "€"; return `${sym}${parseFloat(val || 0).toFixed(2)}`; }
function today() { return new Date().toISOString().split("T")[0]; }
function monthStart() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }
function weekStart() { const d = new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().split("T")[0]; }
function monthRange(year, month) { return { after: `${year}-${String(month).padStart(2,"0")}-01`, before: `${year}-${String(month).padStart(2,"0")}-${new Date(year,month,0).getDate()}` }; }
async function resolveSiteId(siteName, region = "ireland") {
  if (!siteName) return null;
  const data = await dentallyPage("/sites", region);
  const sites = data.sites || [];
  const lower = siteName.toLowerCase();
  const match = sites.find(s => s.name?.toLowerCase().includes(lower) || s.nickname?.toLowerCase().includes(lower));
  return match ? match.id : null;
}

// Shared region parameter description for all tools.
const REGION_DESC = "Which practice group to query: 'ireland' (default) for the Irish practices, or 'uk' for the UK practices (Manchester, Leeds, Glasgow, Enniskillen). Set 'uk' whenever the question is about a UK practice or city.";

function createServer() {
  const server = new McpServer({ name: "dentally-mcp", version: "3.2.0" });

  server.tool("get_rate_limit_status", "Check Dentally API rate limit status for a region. Run this first if queries are failing. region 'ireland' (default) or 'uk'.",
    { region: z.enum(["ireland","uk"]).optional().describe(REGION_DESC) },
    async ({ region = "ireland" }) => {
      const pool = poolFor(region);
      const results = await Promise.all(pool.map((t) => readRateLimit(t)));
      const s = summarisePool(results);
      const lines = [
        `DENTALLY API RATE LIMIT — ${region.toUpperCase()} (${pool.length} distinct token${pool.length === 1 ? "" : "s"})`,
        `${"─".repeat(40)}`,
      ];

      if (!s.usable) {
        if (s.authFailed) {
          lines.push(`Overall Status: 🔑 AUTH FAILED`, ``,
            `Every ${region} token was rejected by Dentally (HTTP 401/403).`,
            `This is NOT a rate limit — the tokens are invalid, expired or revoked,`,
            `and waiting will not help.`, ``,
            `Fix: regenerate the App Tokens in Dentally, then update`,
            `${envNamesFor(region)} in the Render environment.`);
        } else {
          lines.push(`Overall Status: ⚠️ UNAVAILABLE`, ``, `Could not read the rate limit from Dentally.`);
        }
        for (const [i, r] of results.entries()) {
          const why = r.authError ? `AUTH FAILED (HTTP ${r.status})` : r.httpError ? `error: ${r.httpError}` : r.netError ? `unreachable: ${r.netError}` : "unknown";
          lines.push(`Token ${i + 1}: ${why}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
      }

      const pct = s.limit ? Math.round((s.remaining / s.limit) * 100) : 0;
      const status = s.remaining === 0 ? "🚫 EXHAUSTED" : s.remaining < 200 ? "🔴 CRITICAL" : s.remaining < 600 ? "🟡 LOW" : "🟢 OK";
      lines.push(`Overall Status: ${status}`, `Remaining: ${s.remaining} / ${s.limit} (${pct}%)`, ``);
      for (const [i, r] of results.entries()) {
        if (r.authError) { lines.push(`Token ${i + 1}: 🔑 AUTH FAILED (HTTP ${r.status})`); continue; }
        if (typeof r.remaining !== "number") { lines.push(`Token ${i + 1}: ⚠️ unavailable`); continue; }
        const rt = new Date((r.reset || 0) * 1000).toLocaleTimeString(localeFor(region), { hour: "2-digit", minute: "2-digit" });
        lines.push(`Token ${i + 1}: ${r.remaining}/${r.limit} remaining — resets ${rt}`);
      }
      if (s.shared) {
        lines.push(``,
          `⚠️ These ${results.length} tokens report ONE shared quota, not ${results.length} separate ones.`,
          `   Your effective ceiling is ${s.limit}/hr — rotating them does not raise it.`,
          `   Either the same token is in more than one slot, or Dentally meters`,
          `   this quota per account rather than per token.`);
      }
      if (s.remaining === 0) lines.push(``, `⚠️ Quota exhausted for ${region}. Wait for the reset shown above.`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    });

  server.tool("get_patient_debtors", "List patients who owe money. Filter by site name (e.g. 'Dame Street', 'Bray'). Site filtering uses patient ID lookup — accurate but takes 1-2 minutes for large lists. Always checks rate limit first.",
    { site: z.string().optional().describe("Filter by site e.g. 'Dame Street', 'Bray'"), region: z.enum(["ireland","uk"]).optional().describe(REGION_DESC) },
    async ({ site, region = "ireland" }) => {
      const rl = await checkRateLimit(region);
      if (!rl.ok) return { content: [{ type: "text", text: rl.warning }] };
      const accounts = await dentallyAll("/accounts", { state: "debit" }, "accounts", region);
      if (!accounts.length) return { content: [{ type: "text", text: "No debtors found." }] };
      let filtered = accounts;
      if (site) {
        const siteId = await resolveSiteId(site, region);
        if (!siteId) return { content: [{ type: "text", text: `Could not find site "${site}". Use list_sites to see available sites.` }] };
        const BATCH = 10, withSite = [];
        for (let i = 0; i < accounts.length; i += BATCH) {
          const batch = accounts.slice(i, i+BATCH);
          const results = await Promise.all(batch.map(async a => { try { const d = await dentallyPage(`/patients/${a.patient_id||a.id}`, region); return d.patient?.site_id===siteId?a:null; } catch { return null; } }));
          withSite.push(...results.filter(Boolean));
        }
        filtered = withSite;
      }
      if (!filtered.length) return { content: [{ type: "text", text: `No debtors found${site?" for "+site:""}.` }] };
      const sorted = filtered.sort((a,b)=>parseFloat(b.current_balance)-parseFloat(a.current_balance));
      const total = sorted.reduce((s,a)=>s+Math.abs(parseFloat(a.current_balance||0)),0);
      const nc = {}; for (const a of sorted) nc[a.patient_name]=(nc[a.patient_name]||0)+1;
      const rows = sorted.map((a,i)=>`${i+1}. [ID: ${a.patient_id||a.id||"N/A"}] ${a.patient_name} — owes ${money(Math.abs(a.current_balance), region)}${nc[a.patient_name]>1?" ⚠️ DUPLICATE":""}`).join("\n");
      const dc = Object.values(nc).filter(n=>n>1).reduce((s,n)=>s+n,0);
      const lines = [`PATIENT DEBTORS`,`Region: ${region}`,`Site: ${site||"All sites (group-wide)"}`,`As at: today (${today()})`,`Total: ${sorted.length} patients${dc>0?` | ⚠️ ${dc} duplicate names`:""}`,`${"─".repeat(45)}`,rows,`${"─".repeat(45)}`,`TOTAL OUTSTANDING: ${money(total, region)}`];
      lines.push(rlFooter(rl));
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool("get_received_vs_invoiced","Compare invoiced vs received for a date range. Filter by site.",{from_date:z.string(),to_date:z.string(),site:z.string().optional(),region:z.enum(["ireland","uk"]).optional().describe(REGION_DESC)},async({from_date,to_date,site,region="ireland"})=>{
    const rl=await checkRateLimit(region); if(!rl.ok) return{content:[{type:"text",text:rl.warning}]};
    const params={dated_on_after:from_date,dated_on_before:to_date};
    if(site){const id=await resolveSiteId(site,region);if(!id)return{content:[{type:"text",text:`Site "${site}" not found.`}]};params.site_id=id;}
    const invoices=await dentallyAll("/invoices",params,"invoices",region);
    let inv=0,out=0,paid=0,unpaid=0;
    for(const i of invoices){inv+=parseFloat(i.amount||0);out+=parseFloat(i.amount_outstanding||0);i.paid?paid++:unpaid++;}
    const rec=inv-out;
    const lines=[`INVOICED vs RECEIVED`,`Region: ${region}`,`Site: ${site||"All sites"}`,`Period: ${from_date} → ${to_date}`,`${"─".repeat(40)}`,`Total Invoiced: ${money(inv, region)}`,`Total Received: ${money(rec, region)}`,`Still Outstanding: ${money(out, region)}`,`${"─".repeat(40)}`,`Collection Rate: ${inv>0?((rec/inv)*100).toFixed(1):0}%`,`Paid: ${paid} Unpaid: ${unpaid} Total: ${invoices.length}`];
    lines.push(rlFooter(rl));
    return{content:[{type:"text",text:lines.join("\n")}]};
  });

  server.tool("get_revenue_comparison","Compare revenue this month vs last month, quarter, year. Filter by site.",{site:z.string().optional(),region:z.enum(["ireland","uk"]).optional().describe(REGION_DESC)},async({site,region="ireland"})=>{
    const rl=await checkRateLimit(region); if(!rl.ok) return{content:[{type:"text",text:rl.warning}]};
    const now=new Date(),y=now.getFullYear(),m=now.getMonth()+1,todayStr=today();
    const lm=m===1?12:m-1,lmy=m===1?y-1:y,{after:lmA,before:lmB}=monthRange(lmy,lm),qs=Math.floor((m-1)/3)*3+1;
    let sp={};
    if(site){const id=await resolveSiteId(site,region);if(!id)return{content:[{type:"text",text:`Site "${site}" not found.`}]};sp.site_id=id;}
    async function sum(a,b){const items=await dentallyAll("/invoices",{...sp,dated_on_after:a,dated_on_before:b},"invoices",region);return items.reduce((s,i)=>s+parseFloat(i.amount||0),0);}
    const[tm,lmt,tq,ty,ly]=await Promise.all([sum(`${y}-${String(m).padStart(2,"0")}-01`,todayStr),sum(lmA,lmB),sum(`${y}-${String(qs).padStart(2,"0")}-01`,todayStr),sum(`${y}-01-01`,todayStr),sum(`${y-1}-01-01`,`${y-1}-12-31`)]);
    const mom=lmt>0?(((tm-lmt)/lmt)*100).toFixed(1):"N/A",yoy=ly>0?(((ty-ly)/ly)*100).toFixed(1):"N/A";
    const lines=[`REVENUE COMPARISON (as of ${todayStr})`,`Region: ${region}`,`Site: ${site||"All sites"}`,`${"─".repeat(40)}`,`This Month (so far): ${money(tm, region)}`,`Last Month (full): ${money(lmt, region)}`,`Month-on-Month: ${parseFloat(mom)>=0?"📈":"📉"} ${mom}%`,``,`This Quarter (so far): ${money(tq, region)}`,``,`This Year (so far): ${money(ty, region)}`,`Last Year (full): ${money(ly, region)}`,`Year-on-Year: ${parseFloat(yoy)>=0?"📈":"📉"} ${yoy}%`];
    lines.push(rlFooter(rl));
    return{content:[{type:"text",text:lines.join("\n")}]};
  });

  server.tool("get_appointment_overview","Appointments today/week: totals, no-shows, cancellations. Filter by site.",{period:z.enum(["today","week"]).optional(),site:z.string().optional(),region:z.enum(["ireland","uk"]).optional().describe(REGION_DESC)},async({period="today",site,region="ireland"})=>{
    const rl=await checkRateLimit(region); if(!rl.ok) return{content:[{type:"text",text:rl.warning}]};
    const params={after:period==="week"?weekStart():today(),before:today()};
    if(site){const id=await resolveSiteId(site,region);if(id)params.site_id=id;}
    const appts=await dentallyAll("/appointments",params,"appointments",region);
    const completed=appts.filter(a=>a.state==="Completed").length,cancelled=appts.filter(a=>a.state==="Cancelled").length,dna=appts.filter(a=>a.state==="Did not attend").length,pending=appts.filter(a=>["Pending","Confirmed","Arrived","In surgery"].includes(a.state)).length;
    return{content:[{type:"text",text:[`APPOINTMENTS (${period.toUpperCase()})`,`Region: ${region}`,`Site: ${site||"All sites"}`,`${"─".repeat(35)}`,`Total: ${appts.length}`,`Completed: ${completed}`,`Pending/In Progress: ${pending}`,`Cancelled: ${cancelled}`,`Did Not Attend: ${dna}`,`Attendance Rate: ${appts.length>0?((completed/appts.length)*100).toFixed(1):0}%`,rlFooter(rl)].join("\n")}]};
  });

  server.tool("get_pending_treatment_plans","List active treatment plans. Filter by site.",{site:z.string().optional(),region:z.enum(["ireland","uk"]).optional().describe(REGION_DESC)},async({site,region="ireland"})=>{
    const rl=await checkRateLimit(region); if(!rl.ok) return{content:[{type:"text",text:rl.warning}]};
    const params={status:"active"};if(site){const id=await resolveSiteId(site,region);if(id)params.site_id=id;}
    const plans=await dentallyAll("/treatment_plans",params,"treatment_plans",region);
    if(!plans.length)return{content:[{type:"text",text:"No active treatment plans found."}]};
    let total=0;const rows=plans.map((p,i)=>{const v=parseFloat(p.total_gross||p.value||0);total+=v;return `${i+1}. ${p.patient_name||"Unknown"} — ${money(v, region)}`;}).join("\n");
    return{content:[{type:"text",text:[`TREATMENT PLANS (${plans.length})`,`Region: ${region}`,`Site: ${site||"All sites"}`,`${"─".repeat(35)}`,rows,`${"─".repeat(35)}`,`TOTAL: ${money(total, region)}`,rlFooter(rl)].join("\n")}]};
  });

  server.tool("get_nhs_claims","NHS claims status and UDAs. Filter by site or status.",{status:z.string().optional(),site:z.string().optional(),region:z.enum(["ireland","uk"]).optional().describe(REGION_DESC)},async({status,site,region="ireland"})=>{
    const rl=await checkRateLimit(region); if(!rl.ok) return{content:[{type:"text",text:rl.warning}]};
    const params={};if(status)params.claim_status=status;if(site){const id=await resolveSiteId(site,region);if(id)params.site_id=id;}
    const claims=await dentallyAll("/nhs_claims",params,"nhs_claims",region);
    if(!claims.length)return{content:[{type:"text",text:"No NHS claims found."}]};
    const byS={};let uda=0,exp=0;for(const c of claims){byS[c.claim_status]=(byS[c.claim_status]||0)+1;uda+=parseFloat(c.awarded_uda||0);exp+=parseFloat(c.expected_uda||0);}
    return{content:[{type:"text",text:[`NHS CLAIMS (${claims.length})`,`Region: ${region}`,`Site: ${site||"All sites"}`,`${"─".repeat(35)}`,Object.entries(byS).map(([s,n])=>` ${s}: ${n}`).join("\n"),`${"─".repeat(35)}`,`Expected UDAs: ${exp.toFixed(1)}`,`Awarded UDAs: ${uda.toFixed(1)}`,`Difference: ${(uda-exp).toFixed(1)}`,rlFooter(rl)].join("\n")}]};
  });

  server.tool("get_practitioner_performance","Revenue by dentist/hygienist. Filter by site and date.",{from_date:z.string().optional(),to_date:z.string().optional(),site:z.string().optional(),region:z.enum(["ireland","uk"]).optional().describe(REGION_DESC)},async({from_date,to_date,site,region="ireland"})=>{
    const rl=await checkRateLimit(region); if(!rl.ok) return{content:[{type:"text",text:rl.warning}]};
    const after=from_date||monthStart(),before=to_date||today(),params={dated_on_after:after,dated_on_before:before};
    if(site){const id=await resolveSiteId(site,region);if(id)params.site_id=id;}
    const invoices=await dentallyAll("/invoices",params,"invoices",region);
    const byP={};for(const inv of invoices)for(const item of inv.invoice_items||[]){const id=item.practitioner_id||"Unknown";byP[id]=(byP[id]||0)+parseFloat(item.total_price||0);}
    if(!Object.keys(byP).length)return{content:[{type:"text",text:`No data for ${after} to ${before}.`}]};
    const rows=Object.entries(byP).sort((a,b)=>b[1]-a[1]).map(([id,v],i)=>`${i+1}. Practitioner #${id}: ${money(v, region)}`).join("\n");
    const total=Object.values(byP).reduce((s,v)=>s+v,0);
    return{content:[{type:"text",text:[`PRACTITIONER PERFORMANCE`,`Region: ${region}`,`Site: ${site||"All sites"}`,`Period: ${after} → ${before}`,`${"─".repeat(35)}`,rows,`${"─".repeat(35)}`,`TOTAL: ${money(total, region)}`,rlFooter(rl)].join("\n")}]};
  });

  server.tool("get_overdue_recalls","Patients overdue for recall. Filter by site.",{site:z.string().optional(),region:z.enum(["ireland","uk"]).optional().describe(REGION_DESC)},async({site,region="ireland"})=>{
    const rl=await checkRateLimit(region); if(!rl.ok) return{content:[{type:"text",text:rl.warning}]};
    const params={};if(site){const id=await resolveSiteId(site,region);if(id)params.site_id=id;}
    const patients=await dentallyAll("/patients",params,"patients",region);
    const todayStr=today();
    const overdue=patients.filter(p=>(p.dentist_recall_date&&p.dentist_recall_date<todayStr)||(p.hygienist_recall_date&&p.hygienist_recall_date<todayStr));
    if(!overdue.length)return{content:[{type:"text",text:"No patients overdue for recall."}]};
    const rows=overdue.slice(0,50).map((p,i)=>{const parts=[];if(p.dentist_recall_date&&p.dentist_recall_date<todayStr)parts.push(`Dentist: ${p.dentist_recall_date}`);if(p.hygienist_recall_date&&p.hygienist_recall_date<todayStr)parts.push(`Hygienist: ${p.hygienist_recall_date}`);return `${i+1}. [ID: ${p.id||"N/A"}] ${p.first_name} ${p.last_name} — ${parts.join(", ")}`;}).join("\n");
    return{content:[{type:"text",text:[`OVERDUE RECALLS (${overdue.length})`,`Region: ${region}`,`Site: ${site||"All sites"}`,`${"─".repeat(35)}`,rows,overdue.length>50?`...and ${overdue.length-50} more`:"",rlFooter(rl)].join("\n")}]};
  });

  server.tool("get_new_patients","New patients this month vs last month. Filter by site.",{site:z.string().optional(),region:z.enum(["ireland","uk"]).optional().describe(REGION_DESC)},async({site,region="ireland"})=>{
    const rl=await checkRateLimit(region); if(!rl.ok) return{content:[{type:"text",text:rl.warning}]};
    const start=monthStart(),now=new Date(),lm=now.getMonth()===0?12:now.getMonth(),lmy=now.getMonth()===0?now.getFullYear()-1:now.getFullYear(),{after:lmA,before:lmB}=monthRange(lmy,lm);
    const params={};if(site){const id=await resolveSiteId(site,region);if(id)params.site_id=id;}
    const[tm,lm2]=await Promise.all([dentallyAll("/patients",{...params,created_after:start},"patients",region),dentallyAll("/patients",{...params,created_after:lmA,created_before:lmB},"patients",region)]);
    const change=lm2.length>0?(((tm.length-lm2.length)/lm2.length)*100).toFixed(1):"N/A";
    const recent=tm.slice(0,5).map((p,i)=>`${i+1}. [ID: ${p.id||"N/A"}] ${p.first_name} ${p.last_name} — joined ${p.created_at?.split("T")[0]}`).join("\n");
    return{content:[{type:"text",text:[`NEW PATIENTS`,`Region: ${region}`,`Site: ${site||"All sites"}`,`${"─".repeat(35)}`,`This month: ${tm.length}`,`Last month: ${lm2.length}`,`Growth: ${parseFloat(change)>=0?"📈":"📉"} ${change}%`,`${"─".repeat(35)}`,`Most Recent:\n${recent}`,rlFooter(rl)].join("\n")}]};
  });

  server.tool("list_sites","List all practice sites in Dentally for a region",{region:z.enum(["ireland","uk"]).optional().describe(REGION_DESC)},async({region="ireland"})=>{
    const data=await dentallyPage("/sites",region);const sites=data.sites||[];
    if(!sites.length)return{content:[{type:"text",text:"No sites found."}]};
    return{content:[{type:"text",text:`AVAILABLE SITES — ${region.toUpperCase()} (${sites.length})\n${"─".repeat(35)}\n${sites.map((s,i)=>`${i+1}. ${s.name} (nickname: "${s.nickname}") — ID: ${s.id}`).join("\n")}`}]};
  });

  server.tool("get_new_debtors_in_range","Use when asked for debtors BETWEEN two dates or OVER a date range. Compares two group-wide snapshots. NOTE: site filtering not supported on /accounts endpoint.",{from_date:z.string(),to_date:z.string(),region:z.enum(["ireland","uk"]).optional().describe(REGION_DESC)},async({from_date,to_date,region="ireland"})=>{
    const rl=await checkRateLimit(region); if(!rl.ok) return{content:[{type:"text",text:rl.warning}]};
    const[startA,endA]=await Promise.all([dentallyAll("/accounts",{state:"debit",as_at:from_date},"accounts",region),dentallyAll("/accounts",{state:"debit",as_at:to_date},"accounts",region)]);
    const sm={};for(const a of startA)sm[a.patient_id||a.id]=parseFloat(a.current_balance||0);
    const em={};for(const a of endA)em[a.patient_id||a.id]=a;
    const newD=[],worsened=[],cleared=[];
    for(const a of endA){const pid=a.patient_id||a.id,eb=Math.abs(parseFloat(a.current_balance||0));if(!(pid in sm)){newD.push({name:a.patient_name,id:pid,balance:eb});}else{const sb=Math.abs(sm[pid]);if(eb>sb+0.01)worsened.push({name:a.patient_name,id:pid,before:sb,after:eb,increase:eb-sb});}}
    for(const a of startA){const pid=a.patient_id||a.id;if(!(pid in em))cleared.push(a);}
    newD.sort((a,b)=>b.balance-a.balance);worsened.sort((a,b)=>b.increase-a.increase);
    const tn=newD.reduce((s,d)=>s+d.balance,0),tw=worsened.reduce((s,d)=>s+d.increase,0);
    const lines=[`DEBTOR CHANGES: ${from_date} → ${to_date}`,`Region: ${region}`,`(Group-wide — site filtering not supported on /accounts)`,`${"─".repeat(45)}`,`🆕 NEW DEBTORS (${newD.length}) — Total: ${money(tn, region)}`,newD.length?newD.map((d,i)=>`${i+1}. [ID: ${d.id}] ${d.name} — ${money(d.balance, region)}`).join("\n"):"None",``,`📈 WORSENED (${worsened.length}) — Additional: ${money(tw, region)}`,worsened.length?worsened.map((d,i)=>`${i+1}. [ID: ${d.id}] ${d.name} — ${money(d.before, region)} → ${money(d.after, region)} (+${money(d.increase, region)})`).join("\n"):"None",``,`✅ CLEARED (${cleared.length})`,cleared.length?cleared.map((a,i)=>`${i+1}. [ID: ${a.patient_id||a.id}] ${a.patient_name}`).join("\n"):"None"];
    lines.push(rlFooter(rl));
    return{content:[{type:"text",text:lines.join("\n")}]};
  });

  // Cross-reference debtors by treatment period
  server.tool(
    "get_debtors_by_treatment_period",
    "Cross-reference debtors against invoice activity in a date period. mode=include: debtors WHO HAD treatments in the period (e.g. March debtors). mode=exclude: debtors with NO activity in that period (old debts predating the window). Identifies debtors by matching patient IDs across accounts and invoices. Fast - no per-patient API calls.",
    {
      from_date: z.string().describe("Start of period YYYY-MM-DD e.g. 2026-03-01"),
      to_date: z.string().describe("End of period YYYY-MM-DD e.g. 2026-03-31"),
      mode: z.enum(["include","exclude"]).describe("include=debtors WITH invoices in this period. exclude=debtors with NO invoices in this period."),
      site: z.string().optional().describe("Filter invoices by site e.g. Dame Street"),
      region: z.enum(["ireland","uk"]).optional().describe(REGION_DESC),
    },
    async ({ from_date, to_date, mode, site, region = "ireland" }) => {
      const rl = await checkRateLimit(region);
      if (!rl.ok) return { content: [{ type: "text", text: rl.warning }] };

      // Step 1: All debtors (fast bulk call)
      const accounts = await dentallyAll("/accounts", { state: "debit" }, "accounts", region);
      if (!accounts.length) return { content: [{ type: "text", text: "No debtors found." }] };

      // Step 2: All invoices in the date period (fast - date filter supported)
      const invoiceParams = { dated_on_after: from_date, dated_on_before: to_date };
      if (site) {
        const siteId = await resolveSiteId(site, region);
        if (!siteId) return { content: [{ type: "text", text: `Could not find site "${site}". Use list_sites to see available sites.` }] };
        invoiceParams.site_id = siteId;
      }
      const invoices = await dentallyAll("/invoices", invoiceParams, "invoices", region);

      // Step 3: Build set of patient IDs active in this period
      const activeIds = new Set(invoices.map(inv => inv.patient_id).filter(Boolean));

      // Step 4: Filter debtors by cross-referencing patient IDs
      const filtered = mode === "include"
        ? accounts.filter(a => activeIds.has(a.patient_id || a.id))
        : accounts.filter(a => !activeIds.has(a.patient_id || a.id));

      if (!filtered.length) return { content: [{ type: "text", text: `No debtors matched for ${mode} mode in ${from_date} to ${to_date}.` }] };

      const sorted = filtered.sort((a,b) => parseFloat(b.current_balance)-parseFloat(a.current_balance));
      const total = sorted.reduce((s,a) => s+Math.abs(parseFloat(a.current_balance||0)), 0);
      const nc = {}; for (const a of sorted) nc[a.patient_name]=(nc[a.patient_name]||0)+1;
      const rows = sorted.map((a,i) => {
        const dup = nc[a.patient_name]>1?" ⚠️ DUPLICATE":"";
        return `${i+1}. [ID: ${a.patient_id||a.id||"N/A"}] ${a.patient_name} — owes ${money(Math.abs(a.current_balance), region)}${dup}`;
      }).join("\n");
      const dc = Object.values(nc).filter(n=>n>1).reduce((s,n)=>s+n,0);
      const modeLabel = mode==="include"
        ? `🟢 INCLUDE — debtors WITH activity in ${from_date} → ${to_date}`
        : `🟡 EXCLUDE — debtors with NO activity in ${from_date} → ${to_date} (older debts only)`;
      const lines = [
        `DEBTORS BY TREATMENT PERIOD`,
        `Region: ${region}`,
        modeLabel,
        `Site invoices: ${site||"All sites"}`,
        `Invoices found: ${invoices.length} from ${activeIds.size} unique patients`,
        `${"─".repeat(50)}`,
        `Matched debtors: ${sorted.length}${dc>0?` | ⚠️ ${dc} duplicate names`:""}`,
        `${"─".repeat(50)}`,
        rows,
        `${"─".repeat(50)}`,
        `TOTAL OUTSTANDING: ${money(total, region)}`,
      ];
      if (rl.warning) lines.unshift(rl.warning,"");
      lines.push(rlFooter(rl));
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Inbound auth. This endpoint serves patient financial data from a public repo,
// so /mcp must not be open. Enforced whenever MCP_AUTH_TOKEN is set; when it is
// unset the server still runs (so a missing var can't lock you out mid-shift)
// but shouts about it on every start.
// ---------------------------------------------------------------------------
const MCP_AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN || "").trim();
const MAX_BODY_BYTES = 1_000_000;

// Compare hashes so the check is constant-time and length-independent.
function secretMatches(supplied) {
  if (!supplied) return false;
  const a = crypto.createHash("sha256").update(String(supplied)).digest();
  const b = crypto.createHash("sha256").update(MCP_AUTH_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

// Accepts either an Authorization: Bearer header or ?key=<token>, because the
// Claude connector UI takes a URL and offers nowhere to add a header.
function isAuthorised(req, url) {
  if (!MCP_AUTH_TOKEN) return true;
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ") && secretMatches(header.slice(7).trim())) return true;
  return secretMatches(url.searchParams.get("key"));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function sendJsonRpcError(res, httpStatus, code, message, headers = {}) {
  res.writeHead(httpStatus, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
}

const httpServer = http.createServer(async (req, res) => {
  // Parse the URL so a query string (?key=...) doesn't turn into a 404, which an
  // exact `req.url === "/mcp"` comparison used to do.
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch { res.writeHead(400); res.end("Bad request"); return; }

  if (req.method === "GET" && url.pathname === "/health") { res.writeHead(200); res.end("OK"); return; }

  if (req.method === "POST" && url.pathname === "/mcp") {
    if (!isAuthorised(req, url)) {
      sendJsonRpcError(res, 401, -32001,
        "Unauthorized: pass the MCP_AUTH_TOKEN as 'Authorization: Bearer <token>' or append '?key=<token>' to the URL.",
        { "WWW-Authenticate": 'Bearer realm="dentally-mcp"' });
      return;
    }

    let body;
    try { body = await readJsonBody(req); }
    catch (e) { sendJsonRpcError(res, 400, -32700, `Parse error: ${e.message}`); return; }

    // Any throw in here used to escape as an unhandled rejection, which can take
    // the whole process down from a single malformed request.
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("MCP request failed:", e);
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, `Internal error: ${e.message}`);
      else { try { res.end(); } catch {} }
    }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`Dentally MCP server v3.2 running on port ${PORT} ✅`);
  console.log(`  tokens — ireland: ${TOKEN_POOLS.ireland.length} | uk: ${TOKEN_POOLS.uk.length} (duplicates collapsed)`);
  if (MCP_AUTH_TOKEN) {
    console.log("  🔒 inbound auth: ENABLED");
  } else {
    console.warn("  ⚠️  INBOUND AUTH DISABLED — POST /mcp is PUBLIC and serves patient data.");
    console.warn("      Set MCP_AUTH_TOKEN in the Render environment to close this.");
  }
});
