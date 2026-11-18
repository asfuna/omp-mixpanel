import { MixpanelMcpClient, type MixpanelMcpClientOptions } from "./client";
import { MixpanelAuth, type MixpanelAuthOptions } from "./credentials";
import type { MixpanelCore, MixpanelRegion } from "./types";

export interface MixpanelCoreOptions {
	auth?: MixpanelAuthOptions;
	client?: MixpanelMcpClientOptions;
}

/** Match exact MCP tool names first, then tolerate case-only server variations. */
export function findMixpanelTool<T extends { name: string }>(tools: readonly T[], name: string): T | undefined {
	return tools.find(tool => tool.name === name) ?? tools.find(tool => tool.name.toLowerCase() === name.toLowerCase());
}

export function createMixpanelCore(options: MixpanelCoreOptions = {}): MixpanelCore {
	const auth = new MixpanelAuth(options.auth);
	const client = new MixpanelMcpClient(auth, options.client);
	return {
		account: () => auth.account(),
		async login(presenter, region?: MixpanelRegion) {
			const account = await auth.login(presenter, region);
			await client.reset();
			return account;
		},
		async logout() {
			await client.reset();
			await auth.logout();
		},
		listTools: signal => client.listTools(signal),
		callTool: (tool, args, options) => client.callTool(tool, args, options),
		closeAll: () => client.closeAll(),
	};
}

export const mixpanelCore: MixpanelCore = createMixpanelCore();
