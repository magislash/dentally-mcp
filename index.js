import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DENTALLY_API = "https://api.dentally.co/v1";
const DENTALLY_TOKEN = process.env.DENTALLY_API_TOKEN;

async function dentally(path) {
  const res = await fetch(`${DENTALLY_API}${path}`, {
    headers: { Authorization: `Bearer ${DENTALLY_TOKEN}`, "Content-Type": "application/json", "User-Agent": "Dentally-MCP-Server v1" },
  });
  if (!res.ok) throw new Error(`Dentally API error: ${res.status}`);
  return res.json();
}

function gbp(val) { return `£${parseFloat(val || 0).toFixed(2)}`; }
function monthRange(year, month) {
  const after = `${year}-${String(month).padStart(2,"0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  return { after, before: `${year}-${String(month).padStart(2,"0")}-${lastDay}` };
}

const server = new McpServer({ name: "dentally-mcp", version: "1.0.0" });

server.tool("get_patient_debtors", "List all patients who owe money", {}, async () => {
  const data = await dentally("/accounts?state=debit&per_page=100");
  const accounts = data.accounts || [];
  if (!accounts.length) return { content: [{ type: "text", text: "No debtors found." }] };
  const rows = accounts.sort((a,b) => parseFloat(b.current_balance)-parseFloat(a.current_balance))
    .map((a,i) => `${i+1}. ${a.patient_name} — owes ${gbp(Math.abs(a.current_balance))}`).join("\n");
  return { content: [{ type: "text", text: `PATIENT DEBTORS (${accounts.length})\n${rows}\nTOTAL: ${gbp(Math.abs(parseFloat(data.meta?.total_balance||0)))}` }] };
});

server.tool("get_received_vs_invoiced", "Compare invoiced vs received", { from_date: z.string(), to_date: z.string() }, async ({ from_date, to_date }) => {
  const data = await dentally(`/invoices?dated_on_after=${from_date}&dated_on_before=${to_date}&per_page=100`);
  const invoices = data.invoices || [];
  let totalInvoiced=0, totalOutstanding=0, paid=0, unpaid=0;
  for (const inv of invoices) { totalInvoiced+=parseFloat(inv.amount||0); totalOutstanding+=parseFloat(inv.amount_outstanding||0); inv.paid?paid++:unpaid++; }
  const received = totalInvoiced - totalOutstanding;
  return { content: [{ type: "text", text: `INVOICED vs RECEIVED\nInvoiced: ${gbp(totalInvoiced)}\nReceived: ${gbp(received)}\nOutstanding: ${gbp(totalOutstanding)}\nRate: ${((received/totalInvoiced)*100).toFixed(1)}%\nPaid: ${paid} Unpaid: ${unpaid}` }] };
});

server.tool("get_revenue_comparison", "Compare revenue across periods", {}, async () => {
  const now = new Date(); const y=now.getFullYear(); const m=now.getMonth()+1;
  const today=now.toISOString().split("T")[0];
  const thisMonthStart=`${y}-${String(m).padStart(2,"0")}-01`;
  const lm=m===1?12:m-1; const lmy=m===1?y-1:y;
  const {after:lma,before:lmb}=monthRange(lmy,lm);
  const qs=Math.floor((m-1)/3)*3+1;
  const thisQStart=`${y}-${String(qs).padStart(2,"0")}-01`;
  async function sum(a,b){const d=await dentally(`/invoices?dated_on_after=${a}&dated_on_before=${b}&per_page=100`);return(d.invoices||[]).reduce((s,i)=>s+parseFloat(i.amount||0),0);}
  const [tm,lmt,tq,ty,ly]=await Promise.all([sum(thisMonthStart,today),sum(lma,lmb),sum(thisQStart,today),sum(`${y}-01-01`,today),sum(`${y-1}-01-01`,`${y-1}-12-31`)]);
  const mom=lmt>0?(((tm-lmt)/lmt)*100).toFixed(1):"N/A"; const yoy=ly>0?(((ty-ly)/ly)*100).toFixed(1):"N/A";
  return { content: [{ type: "text", text: `REVENUE COMPARISON\nThis Month: ${gbp(tm)}\nLast Month: ${gbp(lmt)}\nMoM: ${parseFloat(mom)>=0?"📈":"📉"} ${mom}%\nThis Quarter: ${gbp(tq)}\nThis Year: ${gbp(ty)}\nLast Year: ${gbp(ly)}\nYoY: ${parseFloat(yoy)>=0?"📈":"📉"} ${yoy}%` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);