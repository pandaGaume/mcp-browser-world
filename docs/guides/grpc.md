# gRPC Client

The `@dev/grpc` package provides a generic gRPC client for calling any
gRPC-compatible backend — LLM inference servers, Ray clusters, custom services.

**Package:** `@dev/grpc` (Node.js only)

---

## Overview

```
 Node.js behavior  ──>  GrpcClient  ──>  Any gRPC service (LLM / Ray / custom)

 Browser  ──>  WsTunnel  ──>  GrpcUpstream  ──>  Remote gRPC server
               (WebSocket)    (bridge)            (LLM/Ray)
```

`GrpcClient` loads any `.proto` file dynamically and supports all four RPC
patterns: unary, server streaming, client streaming, and bidirectional streaming.

For browser integration, the `WsTunnel` provides a WebSocket-to-gRPC bridge
via `GrpcUpstream` (see [Browser integration](#browser-integration-via-wstunnel)).

---

## GrpcClient

### Unary call

```typescript
import { GrpcClient } from "@dev/grpc";

const client = new GrpcClient("localhost", 50051, "./inference.proto");
await client.load();

const result = await client.unary("inference.LLMService", "Predict", {
    prompt: "Explain quantum computing",
    max_tokens: 256,
    temperature: 0.7,
});
console.log(result.text);

client.close();
```

### Server streaming (token-by-token generation)

```typescript
const client = new GrpcClient("localhost", 50051, "./inference.proto");
await client.load();

for await (const chunk of client.serverStream("inference.LLMService", "StreamGenerate", {
    prompt: "Write a poem about Mars",
    max_tokens: 512,
})) {
    process.stdout.write(chunk.token as string);
}

client.close();
```

### Bidirectional streaming (chat)

```typescript
const client = new GrpcClient("localhost", 50051, "./chat.proto");
await client.load();

const stream = client.bidiStream("chat.ChatService", "Converse");

stream.onMessage = (msg) => {
    console.log("Assistant:", msg.content);
};

stream.onEnd = () => console.log("Stream ended");

stream.write({ role: "user", content: "Hello!" });
// ... later
stream.end();
```

### Client streaming

```typescript
const cs = client.clientStream("data.Ingestion", "Upload");
cs.write({ chunk: "part 1" });
cs.write({ chunk: "part 2" });
const response = await cs.end();
console.log(response.status);
```

### Options

```typescript
const client = new GrpcClient("10.0.0.5", 50051, "./inference.proto", {
    useTls: true,
    rootCerts: fs.readFileSync("ca.pem"),
    privateKey: fs.readFileSync("client-key.pem"),
    certChain: fs.readFileSync("client-cert.pem"),
    metadata: { "x-api-key": "secret" },
    channelOptions: { "grpc.max_receive_message_length": 64 * 1024 * 1024 },
});
```

### Raw service client access

For advanced usage, get the underlying `grpc.Client` directly:

```typescript
const raw = client.getServiceClient("inference.LLMService");
// Use the @grpc/grpc-js API directly
```

---

## Browser integration via WsTunnel

gRPC does not work in browsers (requires HTTP/2 trailers). The `WsTunnel`
acts as a bridge: browser clients communicate over WebSocket, and the tunnel
forwards to gRPC backends via `GrpcUpstream`.

### Composite provider routing

Browser clients use **composite provider names** with a slash separator:

```
"<backend>/<provider>"
```

- `"llm-1/camera"` → tunnel routes to gRPC backend `llm-1`
- `"camera"` (no slash) → standard WebSocket provider (unchanged)

### Tunnel configuration

```typescript
import { WsTunnelBuilder } from "@dev/tunnel";

const tunnel = new WsTunnelBuilder()
    .withPort(3000)
    .withStaticMount("/", wwwPath)
    .withGrpcUpstream("llm-1", "localhost", 50051)
    .withGrpcUpstream("llm-2", "10.0.0.5", 50052, { useTls: true })
    .build();

await tunnel.start();
```

### Browser-side usage

```typescript
// Standard MultiplexTransport — composite provider name triggers gRPC routing
const t1 = MultiplexTransport.create("llm-1/camera", "ws://localhost:3000/providers");
const t2 = MultiplexTransport.create("llm-2/camera", "ws://localhost:3000/providers");
const t3 = MultiplexTransport.create("camera", "ws://localhost:3000/providers");

// t1 → tunnel → gRPC backend "llm-1"
// t2 → tunnel → gRPC backend "llm-2"
// t3 → tunnel → WebSocket provider "camera" (standard behavior)
```

The browser does not need any gRPC library. Existing `MultiplexTransport`
works unchanged — only the provider name carries the routing information.

### Mixing WebSocket and gRPC providers

| Provider name | Routing |
| ------------- | ------- |
| `"camera"` | WebSocket provider (direct or multiplex) |
| `"llm-1/camera"` | gRPC backend `llm-1` |
| `"ray/worker-3"` | gRPC backend `ray` |

Provider names must be unique across all types.

---

## Architecture decision records

### Why not gRPC-Web?

gRPC-Web requires a proxy (Envoy, nginx) in front of the gRPC server. The
WsTunnel bridge approach reuses existing infrastructure and requires no
additional proxy. Browser clients use standard WebSocket — no gRPC library
needed in the browser.

### Why composite provider names?

The slash-based routing (`"backend/provider"`) keeps the envelope format
unchanged (`{ provider, payload }`). The tunnel's routing logic treats the
composite name as an opaque key everywhere except in `_sendToProvider` and
`_isProviderConnected`. This is fully backward-compatible — existing WebSocket
providers with simple names continue to work unchanged.

### Why proto-loader (dynamic) instead of code generation?

Dynamic loading via `@grpc/proto-loader` avoids a code generation step in the
build pipeline. The `.proto` file is the single source of truth. This
simplifies maintenance at the cost of slightly less type safety.
