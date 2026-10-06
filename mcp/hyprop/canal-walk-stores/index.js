import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// The live JSON endpoint provided
const STORE_URL = "https://cdn.hyprop.co.za/storeLists/a0e878f8-8443-423c-a4fc-17c82b97fb9b.json";

// Initialize the MCP server
const server = new Server({
  name: "hyprop-stores-mcp",
  version: "1.0.0"
}, {
  capabilities: { tools: {} }
});

// Expose our tools to LibreChat
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_store_list",
        description: "Fetches the live list of Hyprop stores from the remote JSON endpoint.",
        inputSchema: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description: "Optional term to filter stores by name or category (case-insensitive) to reduce payload size."
            }
          }
        }
      }
    ]
  };
});

// Handle when LibreChat decides to use the tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "get_store_list") {
    try {
      // Native Node fetch works great here
      const response = await fetch(STORE_URL);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      let data = await response.json();
      
      // Filter logic: If LibreChat provides a search parameter, filter the JSON to save context length
      const search = request.params.arguments?.search;
      if (search && Array.isArray(data)) {
        const lowerSearch = search.toLowerCase();
        // A simple broad filter converting items to string to catch any match
        data = data.filter(item => JSON.stringify(item).toLowerCase().includes(lowerSearch));
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error fetching data: ${error.message}` }],
        isError: true
      };
    }
  }
  throw new Error(`Tool not found: ${request.params.name}`);
});

// Start the server using Standard I/O
const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
