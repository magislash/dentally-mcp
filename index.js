import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";

const DENTALLY_API = "https://api.dentally.co/v1";
const DENTALLY_TOKEN = process.env.DENTALLY_API_TOKEN;
const PORT = process.env.PORT || 3000;

async function dentallyPage(path) {
  const res = await fetch(`${DENTALLY_API}${path}`, {
    headers: { Authorization: `Bearer ${DENTALLY_TOKEN}`, "Content-Type": "application/json", "User-Agent": "Dentally-MCP-Server v2" },
  });
  if (!res.ok) throw new Error(`Dentally API error: ${res.status} ${res.statusText}`);
  return res.json();
}

// Fetch ALL pages automatically - no more 100 record cap!
async function dentallyAll(endpoint, params = {}, key) {
  let page = 1, allItems = [];
  while (true) {
    const qp = new URLSearchParams({ ...params, per_page: 100, page }).toString();
    const data = await dentallyPage(`${endpoint}?${qp}`);
    const items = data[key] || [];
    allItems = allItems.concat(items);
    const meta = data.meta || {};
    const total = meta.total_count || meta.total || 0;
    if (allItems.length >= total || items.length === 0) break;
    page++;
  }
  return allItems;
}

function gbp(val) { return `£${parseFloat(val || 0).toFixed(2)}`; }
function today() { return new Date().toISOString().split("T")[0]; }
function monthStart() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }
function weekStart() { const d = new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().split("T")[0]; }
function monthRange(year, month) {
  return { after: `${year}-${String(month).padStart(2,"0")}-01`, before: `${year}-${String(month).padStart(2,"0")}-${new Date(year,month,0).getDate()}` };
}

// Resolve "Dame Street" → site_id automatically
async function resolveSiteId(siteName) {
  if (!siteName) return null;
  const data = await dentallyPage("/sites");
  const sites = data.sites || [];
  const match = sites.find(s => s.name?.toLowerCase().includes(siteName.toLowerCase()));
  return match ? match.id : null;
}

function createServer() {
  const server = new McpServer({ name: "dentally-mcp", version: "2.0.0" });

  // 1. Patient Debtors — NOW with site + as_at_date + full pagination
  server.tool("get_patient_debtors", "List patients who owe money. Filter by site name and/or historical as_at_date.",
    { site: z.string().optional().describe("Practice site e.g. 'Dame Street'"), as_at_date: z.string().optional().describe("Historical date YYYY-MM-DD e.g. '2026-03-31'") },
    async ({ site, as_at_date }) => {
      const params = { state: "debit" };
      if (as_at_date) params.as_at = as_at_date;
      if (site) {
        const siteId = await resolveSiteId(site);
        if (!siteId) return { content: [{ type: "text", text: `❌ Could not find site "${site}". Use list_sites to see all available sites.` }] };
        params.site_id = siteId;
      }
      const accounts = await dentallyAll("/accounts", params, "accounts");
      if (!accounts.length) return { content: [{ type: "text", text: `No debtors found${site?" for "+site:""}${as_at_date?" as at "+as_at_date:""}.` }] };
      const sorted = accounts.sort((a,b) => parseFloat(b.current_balance)-parseFloat(a.current_balance));
      const total = sorted.reduce((s,a) => s+Math.abs(parseFloat(a.current_balance||0)), 0);
      const rows = sorted.map((a,i) => `${i+1}. ${a.patient_name} — owes ${gbp(Math.abs(a.current_balance))}`).join("\n");
      return { content: [{ type: "text", text: `PATIENT DEBTORS\nSite: ${site||"All sites"}\nAs at: ${as_at_date||"today ("+today()+")"}\nTotal patients: ${accounts.length}\n${"─".repeat(40)}\n${rows}\n${"─".repeat(40)}\nTOTAL OUTSTANDING: ${gbp(total)}` }] };
    }
  );

  // 2. Received vs Invoiced
  server.tool("get_received_vs_invoiced", "Compare invoiced vs received for a date range. Filter by site.",
    { from_date: z.string(), to_date: z.string(), site: z.string().optional() },
    async ({ from_date, to_date, site }) => {
      const params = { dated_on_after: from_date, dated_on_before: to_date };
      if (site) { const id = await resolveSiteId(site); if (!id) return { content: [{ type: "text", text: `❌ Site "${site}" not found.` }] }; params.site_id = id; }
      const invoices = await dentallyAll("/invoices", params, "invoices");
      let inv=0, out=0, paid=0, unpaid=0;
      for (const i of invoices) { inv+=parseFloat(i.amount||0); out+=parseFloat(i.amount_outstanding||0); i.paid?paid++:unpaid++; }
      const rec = inv-out;
      return { content: [{ type: "text", text: `INVOICED vs RECEIVED\nSite: ${site||"All sites"}\nPeriod: ${from_date} → ${to_date}\n${"─".repeat(40)}\nTotal Invoiced:    ${gbp(inv)}\nTotal Received:    ${gbp(rec)}\nStill Outstanding: ${gbp(out)}\n${"─".repeat(40)}\nCollection Rate:   ${inv>0?((rec/inv)*100).toFixed(1):0}%\nPaid: ${paid}  Unpaid: ${unpaid}  Total: ${invoices.length}` }] };
    }
  );

  // 3. Revenue Comparison
  server.tool("get_revenue_comparison", "Compare revenue this month vs last month, quarter, year. Filter by site.",
    { site: z.string().optional() },
    async ({ site }) => {
      const now = new Date(); const y=now.getFullYear(); const m=now.getMonth()+1;
      const todayStr=today(); const lm=m===1?12:m-1; const lmy=m===1?y-1:y;
      const {after:lmA,before:lmB}=monthRange(lmy,lm); const qs=Math.floor((m-1)/3)*3+1;
      let sp={};
      if (site) { const id=await resolveSiteId(site); if (!id) return { content: [{ type: "text", text: `❌ Site "${site}" not found.` }] }; sp.site_id=id; }
      async function sum(a,b) { const items=await dentallyAll("/invoices",{...sp,dated_on_after:a,dated_on_before:b},"invoices"); return items.reduce((s,i)=>s+parseFloat(i.amount||0),0); }
      const [tm,lmt,tq,ty,ly]=await Promise.all([sum(`${y}-${String(m).padStart(2,"0")}-01`,todayStr),sum(lmA,lmB),sum(`${y}-${String(qs).padStart(2,"0")}-01`,todayStr),sum(`${y}-01-01`,todayStr),sum(`${y-1}-01-01`,`${y-1}-12-31`)]);
      const mom=lmt>0?(((tm-lmt)/lmt)*100).toFixed(1):"N/A"; const yoy=ly>0?(((ty-ly)/ly)*100).toFixed(1):"N/A";
      return { content: [{ type: "text", text: `REVENUE COMPARISON (as of ${todayStr})\nSite: ${site||"All sites"}\n${"─".repeat(40)}\nThis Month (so far):   ${gbp(tm)}\nLast Month (full):     ${gbp(lmt)}\nMonth-on-Month:        ${parseFloat(mom)>=0?"📈":"📉"} ${mom}%\n\nThis Quarter (so far): ${gbp(tq)}\n\nThis Year (so far):    ${gbp(ty)}\nLast Year (full):      ${gbp(ly)}\nYear-on-Year:          ${parseFloat(yoy)>=0?"📈":"📉"} ${yoy}%` }] };
    }
  );

  // 4. Appointment Overview
  server.tool("get_appointment_overview", "Appointments today/this week: totals, no-shows, cancellations. Filter by site.",
    { period: z.enum(["today","week"]).optional(), site: z.string().optional() },
    async ({ period="today", site }) => {
      const params={after:period==="week"?weekStart():today(),before:today()};
      if (site) { const id=await resolveSiteId(site); if (id) params.site_id=id; }
      const appts=await dentallyAll("/appointments",params,"appointments");
      const completed=appts.filter(a=>a.state==="Completed").length;
      const cancelled=appts.filter(a=>a.state==="Cancelled").length;
      const dna=appts.filter(a=>a.state==="Did not attend").length;
      const pending=appts.filter(a=>["Pending","Confirmed","Arrived","In surgery"].includes(a.state)).length;
      return { content: [{ type: "text", text: `APPOINTMENTS (${period.toUpperCase()})\nSite: ${site||"All sites"}\n${"─".repeat(35)}\nTotal: ${appts.length}\nCompleted: ${completed}\nPending/In Progress: ${pending}\nCancelled: ${cancelled}\nDid Not Attend: ${dna}\nAttendance Rate: ${appts.length>0?((completed/appts.length)*100).toFixed(1):0}%` }] };
    }
  );

  // 5. Treatment Plans
  server.tool("get_pending_treatment_plans", "List active treatment plans and values. Filter by site.",
    { site: z.string().optional() },
    async ({ site }) => {
      const params={status:"active"};
      if (site) { const id=await resolveSiteId(site); if (id) params.site_id=id; }
      const plans=await dentallyAll("/treatment_plans",params,"treatment_plans");
      if (!plans.length) return { content: [{ type: "text", text: "No active treatment plans found." }] };
      let total=0;
      const rows=plans.map((p,i)=>{ const v=parseFloat(p.total_gross||p.value||0); total+=v; return `${i+1}. ${p.patient_name||"Unknown"} — ${gbp(v)}`; }).join("\n");
      return { content: [{ type: "text", text: `TREATMENT PLANS (${plans.length})\nSite: ${site||"All sites"}\n${"─".repeat(35)}\n${rows}\n${"─".repeat(35)}\nTOTAL: ${gbp(total)}` }] };
    }
  );

  // 6. NHS Claims
  server.tool("get_nhs_claims", "NHS claims status and UDAs. Filter by site or status.",
    { status: z.string().optional(), site: z.string().optional() },
    async ({ status, site }) => {
      const params={}; if (status) params.claim_status=status;
      if (site) { const id=await resolveSiteId(site); if (id) params.site_id=id; }
      const claims=await dentallyAll("/nhs_claims",params,"nhs_claims");
      if (!claims.length) return { content: [{ type: "text", text: "No NHS claims found." }] };
      const byS={}; let uda=0, exp=0;
      for (const c of claims) { byS[c.claim_status]=(byS[c.claim_status]||0)+1; uda+=parseFloat(c.awarded_uda||0); exp+=parseFloat(c.expected_uda||0); }
      return { content: [{ type: "text", text: `NHS CLAIMS (${claims.length})\nSite: ${site||"All sites"}\n${"─".repeat(35)}\n${Object.entries(byS).map(([s,n])=>`  ${s}: ${n}`).join("\n")}\n${"─".repeat(35)}\nExpected UDAs: ${exp.toFixed(1)}\nAwarded UDAs:  ${uda.toFixed(1)}\nDifference:    ${(uda-exp).toFixed(1)}` }] };
    }
  );

  // 7. Practitioner Performance
  server.tool("get_practitioner_performance", "Revenue by dentist/hygienist. Filter by site and date range.",
    { from_date: z.string().optional(), to_date: z.string().optional(), site: z.string().optional() },
    async ({ from_date, to_date, site }) => {
      const after=from_date||monthStart(); const before=to_date||today();
      const params={dated_on_after:after,dated_on_before:before};
      if (site) { const id=await resolveSiteId(site); if (id) params.site_id=id; }
      const invoices=await dentallyAll("/invoices",params,"invoices");
      const byP={};
      for (const inv of invoices) for (const item of inv.invoice_items||[]) { const id=item.practitioner_id||"Unknown"; byP[id]=(byP[id]||0)+parseFloat(item.total_price||0); }
      if (!Object.keys(byP).length) return { content: [{ type: "text", text: `No data for ${after} to ${before}.` }] };
      const rows=Object.entries(byP).sort((a,b)=>b[1]-a[1]).map(([id,v],i)=>`${i+1}. Practitioner #${id}: ${gbp(v)}`).join("\n");
      const total=Object.values(byP).reduce((s,v)=>s+v,0);
      return { content: [{ type: "text", text: `PRACTITIONER PERFORMANCE\nSite: ${site||"All sites"}\nPeriod: ${after} → ${before}\n${"─".repeat(35)}\n${rows}\n${"─".repeat(35)}\nTOTAL: ${gbp(total)}` }] };
    }
  );

  // 8. Patient Recalls
  server.tool("get_overdue_recalls", "Patients overdue for a recall visit. Filter by site.",
    { site: z.string().optional() },
    async ({ site }) => {
      const params={}; if (site) { const id=await resolveSiteId(site); if (id) params.site_id=id; }
      const patients=await dentallyAll("/patients",params,"patients");
      const todayStr=today();
      const overdue=patients.filter(p=>(p.dentist_recall_date&&p.dentist_recall_date<todayStr)||(p.hygienist_recall_date&&p.hygienist_recall_date<todayStr));
      if (!overdue.length) return { content: [{ type: "text", text: "No patients overdue for recall." }] };
      const rows=overdue.slice(0,50).map((p,i)=>{ const parts=[]; if (p.dentist_recall_date<todayStr) parts.push(`Dentist: ${p.dentist_recall_date}`); if (p.hygienist_recall_date<todayStr) parts.push(`Hygienist: ${p.hygienist_recall_date}`); return `${i+1}. ${p.first_name} ${p.last_name} — ${parts.join(", ")}`; }).join("\n");
      return { content: [{ type: "text", text: `OVERDUE RECALLS (${overdue.length})\nSite: ${site||"All sites"}\n${"─".repeat(35)}\n${rows}${overdue.length>50?"\n...and "+(overdue.length-50)+" more":""}` }] };
    }
  );

  // 9. New Patients
  server.tool("get_new_patients", "New patients this month vs last month. Filter by site.",
    { site: z.string().optional() },
    async ({ site }) => {
      const start=monthStart(); const now=new Date();
      const lm=now.getMonth()===0?12:now.getMonth(); const lmy=now.getMonth()===0?now.getFullYear()-1:now.getFullYear();
      const {after:lmA,before:lmB}=monthRange(lmy,lm);
      const params={}; if (site) { const id=await resolveSiteId(site); if (id) params.site_id=id; }
      const [tm,lm2]=await Promise.all([dentallyAll("/patients",{...params,created_after:start},"patients"),dentallyAll("/patients",{...params,created_after:lmA,created_before:lmB},"patients")]);
      const change=lm2.length>0?(((tm.length-lm2.length)/lm2.length)*100).toFixed(1):"N/A";
      const recent=tm.slice(0,5).map((p,i)=>`${i+1}. ${p.first_name} ${p.last_name} — joined ${p.created_at?.split("T")[0]}`).join("\n");
      return { content: [{ type: "text", text: `NEW PATIENTS\nSite: ${site||"All sites"}\n${"─".repeat(35)}\nThis month: ${tm.length}\nLast month: ${lm2.length}\nGrowth: ${parseFloat(change)>=0?"📈":"📉"} ${change}%\n${"─".repeat(35)}\nMost Recent:\n${recent}` }] };
    }
  );

  // 10. List Sites — so Jimmy can see exact site names
  server.tool("list_sites", "List all practice sites/locations in Dentally", {},
    async () => {
      const data=await dentallyPage("/sites");
      const sites=data.sites||[];
      if (!sites.length) return { content: [{ type: "text", text: "No sites found." }] };
      return { content: [{ type: "text", text: `AVAILABLE SITES (${sites.length})\n${"─".repeat(35)}\n${sites.map((s,i)=>`${i+1}. ${s.name} (ID: ${s.id})`).join("\n")}` }] };
    }
  );

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method==="GET"&&req.url==="/health") { res.writeHead(200); res.end("OK"); return; }
  if (req.method==="POST"&&req.url==="/mcp") {
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    const server=createServer();
    await server.connect(transport);
    const body=await new Promise(resolve=>{let d="";req.on("data",c=>d+=c);req.on("end",()=>resolve(JSON.parse(d)));});
    await transport.handleRequest(req,res,body);
    return;
  }
  res.writeHead(404); res.end("Not found");
});

httpServer.listen(PORT, () => console.log(`Dentally MCP server v2.0 running on port ${PORT} ✅`));