import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import type { MixpanelAccount } from "./types";

export const MAX_RENDERED_CHARS = 32_000;

export const MIXPANEL_SIGN_IN_GUIDANCE =
	"Not signed in to Mixpanel. Run `/mixpanel login [us|eu|in]` or configure `MIXPANEL_SERVICE_ACCOUNT_USERNAME` and `MIXPANEL_SERVICE_ACCOUNT_SECRET`.";

type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function truncate(text: string, limit = MAX_RENDERED_CHARS): string {
	if (text.length <= limit) return text;
	const marker = "\n\n[Mixpanel response truncated.]";
	return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function renderContentBlock(block: MCPToolCallResult["content"][number]): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "image":
			return `[MCP image omitted: ${block.mimeType}]`;
		case "resource": {
			const body = block.resource.text ?? `[Binary resource omitted: ${block.resource.mimeType ?? "unknown type"}]`;
			return `Resource: ${block.resource.uri}\n\n${body}`;
		}
	}
}

/** Prefer structured error details, then fall back to the server's text blocks. */
export function mixpanelErrorText(result: MCPToolCallResult): string {
	const structured = result.structuredContent;
	if (isJsonRecord(structured) && typeof structured.error === "string") {
		return typeof structured.error_code === "string" ? `${structured.error} (${structured.error_code})` : structured.error;
	}
	return result.content.map(renderContentBlock).filter(Boolean).join("\n\n") || "Mixpanel returned an error without details.";
}

/** Render both the human-readable blocks and any structured MCP payload. */
export function renderMcpResult(result: MCPToolCallResult): string {
	if (result.isError) return truncate(mixpanelErrorText(result));
	const sections = result.content.map(renderContentBlock).filter(section => section.length > 0);
	if (result.structuredContent !== undefined) sections.push(`\`\`\`json\n${JSON.stringify(result.structuredContent, null, 2)}\n\`\`\``);
	if (sections.length === 0) sections.push("Mixpanel returned no content.");
	return truncate(sections.join("\n\n"));
}

export function renderMixpanelToolList(tools: readonly MCPToolDefinition[]): string {
	if (tools.length === 0) return "Mixpanel MCP exposes no tools.";
	return [
		"Mixpanel MCP tools (inspect one with `{\"op\":\"schema\",\"tool\":\"<name>\"}`):",
		...tools.map(tool => {
			const firstLine = tool.description?.split(/\r?\n/u, 1)[0]?.trim();
			const readOnly = tool.annotations?.readOnlyHint ? " (read-only)" : "";
			return `- \`${tool.name}\`${readOnly}${firstLine ? ` — ${firstLine}` : ""}`;
		}),
	].join("\n");
}

export function renderMixpanelToolSchema(tool: MCPToolDefinition): string {
	const description = tool.description?.trim();
	return `\`${tool.name}\`${description ? `\n\n${description}` : ""}\n\ninputSchema:\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\``;
}

export function renderMixpanelStatus(account: MixpanelAccount, toolCount: number): string {
	if (account.kind === "service-account") {
		return `Mixpanel service-account login (region ${account.region}; username ${account.username ?? "unknown"}); hosted MCP exposes ${toolCount} tools.`;
	}
	const expires = typeof account.expires === "number" && Number.isFinite(account.expires)
		? new Date(account.expires).toISOString()
		: "unknown";
	return `Mixpanel OAuth login (region ${account.region}; access token expires ${expires}); hosted MCP exposes ${toolCount} tools.`;
}
