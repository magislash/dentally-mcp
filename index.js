import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";

const DENTALLY_API = "https://api.dentally.co/v1";
const DENTALLY_TOKEN = process.env.DENTALLY_API_TOKEN;
const PORT = process.env.PORT || 3000;

async function dentally(path) {
  const res = await fetch(`${DENTALLY_API}${path}`, {
    headers: { Authorization: `Bearer ${DENTALLY_TOKEN}`, "Content-Type": "application/json", "User-Agent": "Dentally-MCP-Server v1" },
  });
  if (!res.ok) throw new Error(`Dentally API error: ${res.status}`);
  return res.json();
}

function gbp(val) { return `£${parseFloat(val || 0).toFixed(2)}`; }
function today() { return new Date().toISOString().split("T")[0]; }
function weekStart() { const d = new Date(); d.setDate(d.getDate() - d.getDay()); return d.toISOString().split("T")[0]; }
function monthStart() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }
function monthRange(year, month) {
  const after = `${year}-${String(month).padStart(2,"0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  return { after, before: `${year}-${String(month).padStart(2,"0")}-${lastDay}` };
}

function createServer() {
  const server = new McpServer({ name: "dentally-mcp", version: "1.0.0" });

  // ── 1. Patient Debtors ───────────────────────────────────────────────────
  server.tool("get_patient_debtors", "List all patients who owe money to the practice", {}, async () => {
    const data = await dentally("/accounts?state=debit&per_page=100");
    const accounts = data.accounts || [];
    if (!accounts.length) return { content: [{ type: "text", text: "No debtors found." }] };
    const rows = accounts.sort((a,b) => parseFloat(b.current_balance)-parseFloat(a.current_balance))
      .map((a,i) => `${i+1}. ${a.patient_name} — owes ${gbp(Math.abs(a.current_balance))}`).join("\n");
    return { content: [{ type: "text", text: `PATIENT DEBTORS (${accounts.length})\n${rows}\nTOTAL: ${gbp(Math.abs(parseFloat(data.meta?.total_balance||0)))}` }] };
  });

  // ── 2. Received vs Invoiced ──────────────────────────────────────────────
  server.tool("get_received_vs_invoiced", "Compare invoiced vs received for a date range", { from_date: z.string(), to_date: z.string() }, async ({ from_date, to_date }) => {
    const data = await dentally(`/invoices?dated_on_after=${from_date}&dated_on_before=${to_date}&per_page=100`);
    const invoices = data.invoices || [];
    let totalInvoiced=0, totalOutstanding=0, paid=0, unpaid=0;
    for (const inv of invoices) { totalInvoiced+=parseFloat(inv.amount||0); totalOutstanding+=parseFloat(inv.amount_outstanding||0); inv.paid?paid++:unpaid++; }
    const received = totalInvoiced - totalOutstanding;
    return { content: [{ type: "text", text: `INVOICED vs RECEIVED\nInvoiced: ${gbp(totalInvoiced)}\nReceived: ${gbp(received)}\nOutstanding: ${gbp(totalOutstanding)}\nRate: ${totalInvoiced>0?((received/totalInvoiced)*100).toFixed(1):0}%\nPaid: ${paid} Unpaid: ${unpaid}` }] };
  });

  // ── 3. Revenue Comparison ────────────────────────────────────────────────
  server.tool("get_revenue_comparison", "Compare revenue across periods", {}, async () => {
    const now = new Date(); const y=now.getFullYear(); const m=now.getMonth()+1;
    const todayStr=today();
    const thisMonthStart=monthStart();
    const lm=m===1?12:m-1; const lmy=m===1?y-1:y;
    const {after:lma,before:lmb}=monthRange(lmy,lm);
    const qs=Math.floor((m-1)/3)*3+1;
    const thisQStart=`${y}-${String(qs).padStart(2,"0")}-01`;
    async function sum(a,b){const d=await dentally(`/invoices?dated_on_after=${a}&dated_on_before=${b}&per_page=100`);return(d.invoices||[]).reduce((s,i)=>s+parseFloat(i.amount||0),0);}
    const [tm,lmt,tq,ty,ly]=await Promise.all([sum(thisMonthStart,todayStr),sum(lma,lmb),sum(thisQStart,todayStr),sum(`${y}-01-01`,todayStr),sum(`${y-1}-01-01`,`${y-1}-12-31`)]);
    const mom=lmt>0?(((tm-lmt)/lmt)*100).toFixed(1):"N/A"; const yoy=ly>0?(((ty-ly)/ly)*100).toFixed(1):"N/A";
    return { content: [{ type: "text", text: `REVENUE COMPARISON\nThis Month: ${gbp(tm)}\nLast Month: ${gbp(lmt)}\nMoM: ${parseFloat(mom)>=0?"📈":"📉"} ${mom}%\nThis Quarter: ${gbp(tq)}\nThis Year: ${gbp(ty)}\nLast Year: ${gbp(ly)}\nYoY: ${parseFloat(yoy)>=0?"📈":"📉"} ${yoy}%` }] };
  });

  // ── 4. Appointment Overview ──────────────────────────────────────────────
  server.tool("get_appointment_overview", "How many appointments today/this week, no-shows, cancellations", { period: z.enum(["today", "week"]).optional() }, async ({ period = "today" }) => {
    const after = period === "week" ? weekStart() : today();
    const before = today();
    const data = await dentally(`/appointments?after=${after}&before=${before}&per_page=100`);
    const appts = data.appointments || [];
    const total = appts.length;
    const completed = appts.filter(a => a.state === "Completed").length;
    const cancelled = appts.filter(a => a.state === "Cancelled").length;
    const dna = appts.filter(a => a.state === "Did not attend").length;
    const pending = appts.filter(a => ["Pending","Confirmed","Arrived","In surgery"].includes(a.state)).length;
    return { content: [{ type: "text", text: `APPOINTMENT OVERVIEW (${period.toUpperCase()})\n───────────────────────────────────\nTotal: ${total}\nCompleted: ${completed}\nPending/In Progress: ${pending}\nCancelled: ${cancelled}\nDid Not Attend: ${dna}\nAttendance Rate: ${total>0?(((completed)/total)*100).toFixed(1):0}%` }] };
  });

  // ── 5. Treatment Plans ───────────────────────────────────────────────────
  server.tool("get_pending_treatment_plans", "List pending treatment plans and their values", {}, async () => {
    const data = await dentally(`/treatment_plans?status=active&per_page=100`);
    const plans = data.treatment_plans || [];
    if (!plans.length) return { content: [{ type: "text", text: "No active treatment plans found." }] };
    let totalValue = 0;
    const rows = plans.slice(0, 20).map((p, i) => {
      const val = parseFloat(p.total_gross || p.value || 0);
      totalValue += val;
      return `${i+1}. ${p.patient_name || "Unknown"} — ${gbp(val)} (${p.status || "active"})`;
    }).join("\n");
    return { content: [{ type: "text", text: `PENDING TREATMENT PLANS (${plans.length} total)\n${rows}\n───────────────────────────────────\nTOTAL VALUE: ${gbp(totalValue)}` }] };
  });

  // ── 6. NHS Claims ────────────────────────────────────────────────────────
  server.tool("get_nhs_claims", "Status of submitted NHS claims and awarded UDAs", { status: z.string().optional() }, async ({ status }) => {
    const query = status ? `?claim_status=${status}&per_page=100` : `?per_page=100`;
    const data = await dentally(`/nhs_claims${query}`);
    const claims = data.nhs_claims || [];
    if (!claims.length) return { content: [{ type: "text", text: "No NHS claims found." }] };
    const byStatus = {};
    let totalAwarded = 0, totalExpected = 0;
    for (const c of claims) {
      byStatus[c.claim_status] = (byStatus[c.claim_status] || 0) + 1;
      totalAwarded += parseFloat(c.awarded_uda || 0);
      totalExpected += parseFloat(c.expected_uda || 0);
    }
    const statusRows = Object.entries(byStatus).map(([s,n]) => `  ${s}: ${n}`).join("\n");
    return { content: [{ type: "text", text: `NHS CLAIMS OVERVIEW (${claims.length} total)\n───────────────────────────────────\nBy Status:\n${statusRows}\n───────────────────────────────────\nExpected UDAs: ${totalExpected.toFixed(1)}\nAwarded UDAs:  ${totalAwarded.toFixed(1)}\nDifference:    ${(totalAwarded - totalExpected).toFixed(1)}` }] };
  });

  // ── 7. Practitioner Performance ──────────────────────────────────────────
  server.tool("get_practitioner_performance", "Revenue breakdown by dentist/hygienist for a date range", { from_date: z.string().optional(), to_date: z.string().optional() }, async ({ from_date, to_date }) => {
    const after = from_date || monthStart();
    const before = to_date || today();
    const data = await dentally(`/invoices?dated_on_after=${after}&dated_on_before=${before}&per_page=100`);
    const invoices = data.invoices || [];
    const byPractitioner = {};
    for (const inv of invoices) {
      const items = inv.invoice_items || [];
      for (const item of items) {
        const id = item.practitioner_id || "Unknown";
        if (!byPractitioner[id]) byPractitioner[id] = 0;
        byPractitioner[id] += parseFloat(item.total_price || 0);
      }
    }
    if (!Object.keys(byPractitioner).length) return { content: [{ type: "text", text: `No revenue data found for ${after} to ${before}.` }] };
    const rows = Object.entries(byPractitioner)
      .sort((a,b) => b[1]-a[1])
      .map(([id, val], i) => `${i+1}. Practitioner #${id}: ${gbp(val)}`)
      .join("\n");
    const total = Object.values(byPractitioner).reduce((s,v) => s+v, 0);
    return { content: [{ type: "text", text: `PRACTITIONER PERFORMANCE (${after} → ${before})\n${rows}\n───────────────────────────────────\nTOTAL: ${gbp(total)}` }] };
  });

  // ── 8. Patient Recalls ───────────────────────────────────────────────────
  server.tool("get_overdue_recalls", "List patients overdue for a recall visit", {}, async () => {
    const todayStr = today();
    const data = await dentally(`/patients?per_page=100`);
    const patients = data.patients || [];
    const overdue = patients.filter(p => {
      const dentistRecall = p.dentist_recall_date && p.dentist_recall_date < todayStr;
      const hygRecall = p.hygienist_recall_date && p.hygienist_recall_date < todayStr;
      return dentistRecall || hygRecall;
    });
    if (!overdue.length) return { content: [{ type: "text", text: "No patients overdue for recall." }] };
    const rows = overdue.slice(0, 20).map((p, i) => {
      const parts = [];
      if (p.dentist_recall_date && p.dentist_recall_date < todayStr) parts.push(`Dentist recall due: ${p.dentist_recall_date}`);
      if (p.hygienist_recall_date && p.hygienist_recall_date < todayStr) parts.push(`Hygienist recall due: ${p.hygienist_recall_date}`);
      return `${i+1}. ${p.first_name} ${p.last_name} — ${parts.join(", ")}`;
    }).join("\n");
    return { content: [{ type: "text", text: `OVERDUE RECALLS (${overdue.length} patients)\n${rows}` }] };
  });

  // ── 9. New Patients This Month ───────────────────────────────────────────
  server.tool("get_new_patients", "New patients acquired this month and growth tracking", {}, async () => {
    const start = monthStart();
    const todayStr = today();
    const now = new Date();
    const lm = now.getMonth() === 0 ? 12 : now.getMonth();
    const lmy = now.getMonth() === 0 ? now.getFullYear()-1 : now.getFullYear();
    const {after: lmAfter, before: lmBefore} = monthRange(lmy, lm);
    const [thisMonth, lastMonth] = await Promise.all([
      dentally(`/patients?created_after=${start}&per_page=100`),
      dentally(`/patients?created_after=${lmAfter}&created_before=${lmBefore}&per_page=100`)
    ]);
    const thisCount = thisMonth.meta?.total || thisMonth.patients?.length || 0;
    const lastCount = lastMonth.meta?.total || lastMonth.patients?.length || 0;
    const change = lastCount > 0 ? (((thisCount - lastCount) / lastCount) * 100).toFixed(1) : "N/A";
    const arrow = parseFloat(change) >= 0 ? "📈" : "📉";
    const recent = (thisMonth.patients || []).slice(0, 5).map((p,i) => `${i+1}. ${p.first_name} ${p.last_name} — joined ${p.created_at?.split("T")[0]}`).join("\n");
    return { content: [{ type: "text", text: `NEW PATIENTS THIS MONTH\n───────────────────────────────────\nThis month: ${thisCount}\nLast month: ${lastCount}\nGrowth: ${arrow} ${change}%\n───────────────────────────────────\nMost Recent:\n${recent}` }] };
  });

  return server;
}

// HTTP server for Render
const httpServer = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200); res.end("OK"); return;
  }
  if (req.method === "POST" && req.url === "/mcp") {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, await new Promise(resolve => {
      let body = ""; req.on("data", c => body += c); req.on("end", () => resolve(JSON.parse(body)));
    }));
    return;
  }
  res.writeHead(404); res.end("Not found");
});

httpServer.listen(PORT, () => console.log(`Dentally MCP server running on port ${PORT} ✅`));