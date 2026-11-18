import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerMixpanelCommand } from "./command";
import { mixpanelCore } from "./core";
import { registerMixpanelTool } from "./tool";

/** Sessions in this process share the hosted MCP connection. */
let activeSessions = 0;

export default function mixpanelExtension(pi: ExtensionAPI): void {
	registerMixpanelTool(pi, mixpanelCore);
	registerMixpanelCommand(pi, mixpanelCore);
	activeSessions++;
	let shutdownHandled = false;

	pi.on("session_shutdown", async () => {
		if (shutdownHandled) return;
		shutdownHandled = true;
		if (--activeSessions > 0) return;
		await mixpanelCore.closeAll();
	});
}
