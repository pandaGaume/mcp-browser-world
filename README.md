# mcp-for-babylon
This is an experiment in integrating MCP into Babylon.js, with Babylon.js acting as the MCP server.
The server is typically accessed over WebSocket. 
The project has two main components: **mcp-core**, which provides common MCP services, and **mcp-extension**, which enables pluggable behaviors built on top of the mcp-core foundation. These behaviors can include camera manipulation, material changes, and similar scene operations. You can add as many behaviors as needed, with each one contributing resources and tools to the server.
