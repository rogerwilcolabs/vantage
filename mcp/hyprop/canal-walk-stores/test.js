import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function runTest() {
  // 1. Tell the client how to start your server
  const transport = new StdioClientTransport({
    command: "node",
    args: ["index.js"] 
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" }, 
    { capabilities: {} }
  );
  
  console.log("Connecting to MCP server...");
  await client.connect(transport);
  
  console.log("Fetching tools list...");
  const tools = await client.listTools();
  console.log("Available tools:", tools.tools.map(t => t.name));

  console.log("\nCalling 'get_store_list'...");
  
  // 2. Execute the tool (add a search string to test the filter logic)
  const result = await client.callTool({
    name: "get_store_list",
    arguments: {
      // search: "clothing" // Uncomment to test the search filter
    }
  });

  // 3. Print the payload
  console.log("\nResponse received. First 500 characters:");
  const textOutput = result.content[0].text;
  console.log(textOutput.substring(0, 500) + "...\n");
  
  process.exit(0);
}

runTest().catch(console.error);
