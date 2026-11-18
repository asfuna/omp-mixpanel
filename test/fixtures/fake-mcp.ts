import { MCP_PROTOCOL_VERSION } from "@oh-my-pi/pi-coding-agent/mcp";

export interface FakeMixpanelRequest {
	method: string;
	authorization: string | null;
	tool?: string;
}

export interface FakeMixpanelToolCall {
	name: string;
	args: Record<string, unknown>;
}

export interface FakeMixpanelOptions {
	/** Bearer payloads answered with HTTP 401. */
	rejectedTokens?: Set<string>;
	onToolCall?: (call: FakeMixpanelToolCall) => unknown;
}

export interface FakeMixpanel {
	endpoint: string;
	requests: FakeMixpanelRequest[];
	stop(): Promise<void>;
}

export const FAKE_MIXPANEL_TOOLS = [
	{
		name: "Get-Projects",
		description: "List the Mixpanel projects available to the current account.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "Run-Query",
		description: "Run a Mixpanel query using its schema.",
		inputSchema: { type: "object", properties: { project_id: { type: "string" } } },
	},
];

function response(id: unknown, result: unknown): Response {
	return Response.json({ jsonrpc: "2.0", id, result });
}

export function createFakeMixpanel(options: FakeMixpanelOptions = {}): FakeMixpanel {
	const requests: FakeMixpanelRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			let message: Record<string, unknown>;
			try {
				message = (await request.json()) as Record<string, unknown>;
			} catch {
				return Response.json({ error: "invalid JSON" }, { status: 400 });
			}
			const method = typeof message.method === "string" ? message.method : "";
			const authorization = request.headers.get("authorization");
			const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
			const tool = typeof params.name === "string" ? params.name : undefined;
			requests.push({ method, authorization, ...(tool ? { tool } : {}) });

			const bearer = authorization?.replace(/^Bearer\s+/u, "") ?? "";
			if (options.rejectedTokens?.has(bearer) || (authorization && options.rejectedTokens?.has(authorization))) {
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}

			const id = message.id;
			switch (method) {
				case "initialize":
					return response(id, {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "fake-mixpanel", version: "1.0.0" },
					});
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				case "tools/list":
					return response(id, { tools: FAKE_MIXPANEL_TOOLS });
				case "tools/call": {
					const result =
						options.onToolCall?.({
							name: tool ?? "",
							args: (params.arguments as Record<string, unknown> | undefined) ?? {},
						}) ?? {
							content: [{ type: "text", text: "Mixpanel request completed." }],
							structuredContent: { ok: true },
						};
					return response(id, result);
				}
				default:
					return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
			}
		},
	});

	return {
		endpoint: `http://127.0.0.1:${server.port}/mcp`,
		requests,
		async stop() {
			await server.stop(true);
		},
	};
}
