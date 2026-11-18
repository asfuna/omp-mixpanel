import { expect, test } from "bun:test";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { mixpanelApproval, executeMixpanelOperation } from "../src/tool";
import type { MixpanelAccount, MixpanelCore } from "../src/types";

const TOOLS: MCPToolDefinition[] = [
	{
		name: "Get-Projects",
		description: "List the projects available to this account.\nAdditional documentation",
		inputSchema: { type: "object", properties: { project_id: { type: "string" } } },
		annotations: { readOnlyHint: true },
	},
	{
		name: "Delete-Dashboard",
		description: "Delete an existing dashboard.",
		inputSchema: { type: "object", properties: { dashboard_id: { type: "string" } }, required: ["dashboard_id"] },
	},
];

interface FakeCore extends MixpanelCore {
	calls: Array<{ tool: string; args: Record<string, unknown> }>;
	listToolsCalls: number;
}

function fakeCore(result: MCPToolCallResult, accountValue?: MixpanelAccount): FakeCore {
	const calls: FakeCore["calls"] = [];
	let listToolsCalls = 0;
	const unused = async (): Promise<never> => {
		throw new Error("unused");
	};
	return {
		calls,
		get listToolsCalls() {
			return listToolsCalls;
		},
		account: async () => accountValue,
		login: unused,
		logout: unused,
		closeAll: unused,
		async listTools() {
			listToolsCalls++;
			return TOOLS;
		},
		async callTool(tool, args) {
			calls.push({ tool, args });
			return result;
		},
	};
}

const textOf = (result: { content: Array<{ type: "text"; text: string }> }) => result.content.map(block => block.text).join("\n");

const EMPTY_RESULT: MCPToolCallResult = { content: [] };

test("tools lists names and first descriptions; schema exposes one input shape", async () => {
	const core = fakeCore(EMPTY_RESULT);
	const list = textOf(await executeMixpanelOperation(core, { op: "tools" }));
	expect(list).toContain("- `Get-Projects` (read-only) — List the projects available to this account.");
	expect(list).toContain("- `Delete-Dashboard` — Delete an existing dashboard.");
	expect(list).not.toContain("Additional documentation");
	expect(list).not.toContain("inputSchema");

	const schema = textOf(await executeMixpanelOperation(core, { op: "schema", tool: "get-projects" }));
	expect(schema).toContain("`Get-Projects`");
	expect(schema).toContain('"project_id"');
});

test("calls use the server's exact tool name and render structured results", async () => {
	const core = fakeCore({
		content: [{ type: "text", text: "Project found" }],
		structuredContent: { project_id: "p1", name: "Product" },
	});
	const result = await executeMixpanelOperation(core, { tool: "get-projects", args: { project_id: "p1" } });
	expect(core.calls).toEqual([{ tool: "Get-Projects", args: { project_id: "p1" } }]);
	expect(textOf(result)).toContain("Project found");
	expect(textOf(result)).toContain('"project_id": "p1"');
});

test("surfaces MCP errors from structured error details", async () => {
	const core = fakeCore({
		content: [{ type: "text", text: "Request failed" }],
		structuredContent: { error: "Project access denied", error_code: "FORBIDDEN" },
		isError: true,
	});
	const result = await executeMixpanelOperation(core, { tool: "Get-Projects" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toBe("Project access denied (FORBIDDEN)");
});

test("refuses unknown tools before dispatch and requires a schema tool name", async () => {
	const core = fakeCore(EMPTY_RESULT);
	await expect(executeMixpanelOperation(core, { tool: "Search-People" })).rejects.toThrow(
		'no tool "Search-People". Available tools: Get-Projects, Delete-Dashboard',
	);
	await expect(executeMixpanelOperation(core, { op: "schema" })).rejects.toThrow("requires a tool name");
	expect(core.calls).toEqual([]);
});

test("status reports service-account identity, region, and tool count", async () => {
	const core = fakeCore(EMPTY_RESULT, { kind: "service-account", region: "eu", username: "analytics-bot" });
	const status = textOf(await executeMixpanelOperation(core, { op: "status" }));
	expect(status).toContain("service-account");
	expect(status).toContain("region eu");
	expect(status).toContain("username analytics-bot");
	expect(status).toContain("exposes 2 tools");
});

test("status reports OAuth token expiry and skips tool discovery when signed out", async () => {
	const oauth = fakeCore(EMPTY_RESULT, { kind: "oauth", region: "us", expires: Date.UTC(2027, 0, 2), });
	const status = textOf(await executeMixpanelOperation(oauth, { op: "status" }));
	expect(status).toContain("OAuth login");
	expect(status).toContain("region us");
	expect(status).toContain("2027-01-02T00:00:00.000Z");
	expect(status).toContain("exposes 2 tools");

	const signedOut = fakeCore(EMPTY_RESULT);
	const guidance = textOf(await executeMixpanelOperation(signedOut, { op: "status" }));
	expect(guidance).toContain("/mixpanel login");
	expect(signedOut.listToolsCalls).toBe(0);
});

test("login operation delegates its optional region and reports resulting status", async () => {
	const core = fakeCore(EMPTY_RESULT);
	let requestedRegion: string | undefined;
	const result = await executeMixpanelOperation(core, { op: "login", region: "in" }, {
		login: async region => {
			requestedRegion = region;
			return { kind: "oauth", region: region ?? "us", expires: Date.UTC(2027, 0, 2) };
		},
	});
	expect(requestedRegion).toBe("in");
	expect(textOf(result)).toContain("region in");
	expect(textOf(result)).toContain("exposes 2 tools");
	await expect(executeMixpanelOperation(core, { op: "login" })).rejects.toThrow("/mixpanel login");
});

test("only discovery and documented read-only tools skip write approval", () => {
	for (const tool of ["Get-Projects", "List-Dashboards", "Search-Entities", "Describe-Cohort-Schema", "Display-Query", "Find-Duplicate-Groups", "Explain-Experiment-Health-Check", "Run-Query", "Run-Experiment-Pre-Launch-Checks"]) {
		expect(mixpanelApproval({ tool })).toBe("read");
	}
	for (const op of ["tools", "schema", "status"]) expect(mixpanelApproval({ op })).toBe("read");
	for (const tool of ["Create-Dashboard", "Update-Feature-Flag", "Delete-Cohort", "Edit-Event", "Merge-Group", "Dismiss-Issues", "Rename-Tag", "Run-Experiment"]) {
		expect(mixpanelApproval({ tool })).toBe("write");
	}
	expect(mixpanelApproval({ op: "login" })).toBe("write");
	expect(mixpanelApproval({ op: "schema", tool: "Delete-Dashboard" })).toBe("read");
	expect(mixpanelApproval({})).toBe("write");
});
