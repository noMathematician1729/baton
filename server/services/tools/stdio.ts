import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSyntheticToolServer } from "./mcp.js";

const server = createSyntheticToolServer();
await server.connect(new StdioServerTransport());
