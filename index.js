import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";

const DENTALLY_API = "https://api.dentally.co/v1";
const DENTALLY_RATE_URL = "https://api.dentally.co/rate_limit";
const DENTALLY_TOKEN = process.env.DENTALLY_API_TOKEN;
const PORT = process.env.PORT || 3000;
