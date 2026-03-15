import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Protobuf message types (mirrors mcp.proto)
// ---------------------------------------------------------------------------

export interface McpMessage {
    payload: string;
}

export interface McpEnvelope {
    provider: string;
    payload: string;
}

// ---------------------------------------------------------------------------
// gRPC service type definitions
// ---------------------------------------------------------------------------

/** Bidirectional streaming call for the direct McpTransport service. */
export type McpChannelCall = grpc.ClientDuplexStream<McpMessage, McpMessage>;

/** Bidirectional streaming call for the multiplexed McpMultiplexTransport service. */
export type McpMultiplexChannelCall = grpc.ClientDuplexStream<McpEnvelope, McpEnvelope>;

/** Server-side bidirectional streaming handler for McpTransport. */
export type McpChannelHandler = grpc.handleBidiStreamingCall<McpMessage, McpMessage>;

/** Server-side bidirectional streaming handler for McpMultiplexTransport. */
export type McpMultiplexChannelHandler = grpc.handleBidiStreamingCall<McpEnvelope, McpEnvelope>;

// ---------------------------------------------------------------------------
// Service client types
// ---------------------------------------------------------------------------

export interface McpTransportClient extends grpc.Client {
    Channel(): McpChannelCall;
}

export interface McpMultiplexTransportClient extends grpc.Client {
    Channel(): McpMultiplexChannelCall;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GrpcServiceClient = new (address: string, credentials: grpc.ChannelCredentials, options?: any) => McpTransportClient;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GrpcMultiplexServiceClient = new (address: string, credentials: grpc.ChannelCredentials, options?: any) => McpMultiplexTransportClient;

// ---------------------------------------------------------------------------
// Proto loading
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTO_PATH = join(__dirname, "..", "proto", "mcp.proto");

let _cachedPackage: grpc.GrpcObject | null = null;

/**
 * Loads the MCP proto definition and returns the gRPC package object.
 * The result is cached — subsequent calls return the same object.
 */
export async function loadMcpProto(): Promise<grpc.GrpcObject> {
    if (_cachedPackage) return _cachedPackage;

    const packageDefinition = await protoLoader.load(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
    });

    _cachedPackage = grpc.loadPackageDefinition(packageDefinition);
    return _cachedPackage;
}

/**
 * Returns the McpTransport service client constructor.
 */
export async function getMcpTransportClient(): Promise<GrpcServiceClient> {
    const pkg = await loadMcpProto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (pkg.mcp as any).McpTransport as GrpcServiceClient;
}

/**
 * Returns the McpMultiplexTransport service client constructor.
 */
export async function getMcpMultiplexTransportClient(): Promise<GrpcMultiplexServiceClient> {
    const pkg = await loadMcpProto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (pkg.mcp as any).McpMultiplexTransport as GrpcMultiplexServiceClient;
}

/**
 * Returns the McpTransport service definition for server-side use.
 */
export async function getMcpTransportService(): Promise<grpc.ServiceDefinition> {
    const pkg = await loadMcpProto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = (pkg.mcp as any).McpTransport as { service: grpc.ServiceDefinition };
    return svc.service;
}

/**
 * Returns the McpMultiplexTransport service definition for server-side use.
 */
export async function getMcpMultiplexTransportService(): Promise<grpc.ServiceDefinition> {
    const pkg = await loadMcpProto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = (pkg.mcp as any).McpMultiplexTransport as { service: grpc.ServiceDefinition };
    return svc.service;
}

// ---------------------------------------------------------------------------
// Credentials helpers
// ---------------------------------------------------------------------------

/** Creates insecure (plaintext) channel credentials. */
export function createInsecureCredentials(): grpc.ChannelCredentials {
    return grpc.credentials.createInsecure();
}

/** Creates SSL channel credentials from PEM-encoded buffers. */
export function createSslCredentials(
    rootCerts?: Buffer | null,
    privateKey?: Buffer | null,
    certChain?: Buffer | null
): grpc.ChannelCredentials {
    return grpc.credentials.createSsl(rootCerts, privateKey, certChain);
}

/** Creates insecure server credentials (no TLS). */
export function createInsecureServerCredentials(): grpc.ServerCredentials {
    return grpc.ServerCredentials.createInsecure();
}

// ---------------------------------------------------------------------------
// Reconnection helper
// ---------------------------------------------------------------------------

/**
 * Computes the next reconnection delay using exponential backoff with jitter.
 * Same algorithm as MultiplexSocket in @dev/core.
 */
export function reconnectDelay(attempt: number, baseMs = 1_000, maxMs = 30_000): number {
    const jitter = 0.5 + Math.random() * 0.5;
    return Math.min(baseMs * 2 ** attempt, maxMs) * jitter;
}
