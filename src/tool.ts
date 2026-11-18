import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { findMixpanelTool, mixpanelCore } from "./core";
import { runMixpanelLogin } from "./login";
import mixpanelToolDescription from "./prompts/mixpanel-tool.md" with { type: "text" };
import {
	MIXPANEL_SIGN_IN_GUIDANCE,
	renderMcpResult,
	renderMixpanelStatus,
	renderMixpanelToolList,
	renderMixpanelToolSchema,
} from "./render";
import { MIXPANEL_REGIONS } from "./types";
import type { MixpanelAccount, MixpanelCore, MixpanelRegion } from "./types";

const DEVICE_OPS = ["call", "tools", "schema", "login", "status"] as const;
export type MixpanelToolOperation = (typeof DEVICE_OPS)[number];

export interface MixpanelToolInput {
	op?: MixpanelToolOperation;
	tool?: string;
	args?: Record<string, unknown>;
	region?: MixpanelRegion;
}

export interface MixpanelOperationOptions {
	login?: (region?: MixpanelRegion) => Promise<MixpanelAccount>;
	signal?: AbortSignal;
}

export interface MixpanelToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: { structuredContent?: unknown };
	isError?: boolean;
}

function textResult(text: string): MixpanelToolResult {
	return { content: [{ type: "text", text }], details: {} };
}

async function requireMixpanelTool(
	core: MixpanelCore,
	name: string | undefined,
	operation: string,
	signal?: AbortSignal,
): Promise<MCPToolDefinition> {
	const requested = name?.trim();
	if (!requested) throw new Error(`Mixpanel MCP "${operation}" operation requires a tool name.`);
	const tools = await core.listTools(signal);
	const tool = findMixpanelTool(tools, requested);
	if (!tool) {
		throw new Error(`Mixpanel MCP has no tool "${requested}". Available tools: ${tools.map(candidate => candidate.name).join(", ") || "none"}.`);
	}
	return tool;
}

/** Dispatch one generic operation to Mixpanel's hosted MCP server. */
export async function executeMixpanelOperation(
	core: MixpanelCore,
	input: MixpanelToolInput,
	{ login, signal }: MixpanelOperationOptions = {},
): Promise<MixpanelToolResult> {
	switch (input.op ?? "call") {
		case "login": {
			if (!login) throw new Error(`Mixpanel sign-in cannot be presented here; run \`/mixpanel login [us|eu|in]\`.`);
			const account = await login(input.region);
			return textResult(renderMixpanelStatus(account, (await core.listTools(signal)).length));
		}
		case "status": {
			const account = await core.account();
			if (!account) return textResult(MIXPANEL_SIGN_IN_GUIDANCE);
			return textResult(renderMixpanelStatus(account, (await core.listTools(signal)).length));
		}
		case "tools":
			return textResult(renderMixpanelToolList(await core.listTools(signal)));
		case "schema": {
			const tool = await requireMixpanelTool(core, input.tool, "schema", signal);
			return textResult(renderMixpanelToolSchema(tool));
		}
		case "call": {
			const tool = await requireMixpanelTool(core, input.tool, "call", signal);
			const result = await core.callTool(tool.name, input.args ?? {}, signal);
			return {
				content: [{ type: "text", text: renderMcpResult(result) }],
				details: result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent },
				...(result.isError ? { isError: true } : {}),
			};
		}
	}
}

/** Only clearly read-oriented Mixpanel tools skip write approval. */
const READ_ONLY_MIXPANEL_TOOL = /^(?:Get|List|Search|Describe|Display|Find|Explain)-|^(?:Run-Query|Run-Experiment-Pre-Launch-Checks)$/u;

export function mixpanelApproval(args: unknown): "read" | "write" {
	const { op = "call", tool } = (args ?? {}) as MixpanelToolInput;
	if (op === "tools" || op === "schema" || op === "status") return "read";
	return op === "call" && typeof tool === "string" && READ_ONLY_MIXPANEL_TOOL.test(tool.trim()) ? "read" : "write";
}

/** A discoverable Mixpanel device; individual tool schemas arrive only through `schema`. */
export function registerMixpanelTool(pi: ExtensionAPI, core: MixpanelCore = mixpanelCore): void {
	const z = pi.zod;
	pi.registerTool({
		name: "mixpanel",
		label: "Mixpanel",
		description: mixpanelToolDescription.trim(),
		loadMode: "discoverable",
		approval: mixpanelApproval,
		parameters: z
			.object({
				op: z.enum([...DEVICE_OPS]).default("call"),
				tool: z.string().optional().describe("Mixpanel MCP tool name; required for call and schema."),
				args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the named Mixpanel MCP tool, per its schema."),
				region: z.enum([...MIXPANEL_REGIONS]).optional().describe("login: Mixpanel data region (us, eu, or in)."),
			})
			.strict(),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeMixpanelOperation(core, params, {
				login: region => runMixpanelLogin(ctx, core, region, signal),
				signal,
			});
		},
	});
}
