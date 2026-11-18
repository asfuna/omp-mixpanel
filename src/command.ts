import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { mixpanelCore } from "./core";
import { runMixpanelLogin } from "./login";
import { MIXPANEL_SIGN_IN_GUIDANCE, renderMixpanelStatus } from "./render";
import { MIXPANEL_REGIONS } from "./types";
import type { MixpanelCore, MixpanelRegion } from "./types";

const SUBCOMMANDS = ["login", "logout", "status"] as const;
type MixpanelSubcommand = (typeof SUBCOMMANDS)[number];

const USAGE = "Mixpanel commands: /mixpanel login [us|eu|in], /mixpanel logout, /mixpanel status.";

function isSubcommand(value: string): value is MixpanelSubcommand {
	return SUBCOMMANDS.some(candidate => candidate === value);
}

function isRegion(value: string): value is MixpanelRegion {
	return (MIXPANEL_REGIONS as readonly string[]).includes(value);
}

async function handleMixpanelCommand(args: string, ctx: ExtensionCommandContext, core: MixpanelCore): Promise<void> {
	const parts = args.trim().toLowerCase().split(/\s+/u).filter(Boolean);
	if (parts.length === 0) {
		ctx.ui.notify(USAGE, "info");
		return;
	}
	const subcommand = parts[0]!;
	if (!isSubcommand(subcommand)) {
		ctx.ui.notify(USAGE, "error");
		return;
	}
	if ((subcommand !== "login" && parts.length > 1) || (subcommand === "login" && parts.length > 2)) {
		ctx.ui.notify(USAGE, "error");
		return;
	}
	const regionArg = subcommand === "login" ? parts[1] : undefined;
	if (regionArg && !isRegion(regionArg)) {
		ctx.ui.notify(USAGE, "error");
		return;
	}
	const region = regionArg as MixpanelRegion | undefined;

	try {
		switch (subcommand) {
			case "login": {
				const account = await runMixpanelLogin(ctx, core, region);
				ctx.ui.notify(renderMixpanelStatus(account, (await core.listTools()).length), "info");
				return;
			}
			case "logout":
				await core.logout();
				ctx.ui.notify("Signed out of the Mixpanel OAuth login. Configured service-account credentials are unchanged.", "info");
				return;
			case "status": {
				const account = await core.account();
				if (!account) {
					ctx.ui.notify(MIXPANEL_SIGN_IN_GUIDANCE, "info");
					return;
				}
				ctx.ui.notify(renderMixpanelStatus(account, (await core.listTools()).length), "info");
				return;
			}
		}
	} catch (error) {
		if (error instanceof LoginCancelledError) {
			ctx.ui.notify("Login cancelled", "info");
			return;
		}
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export function registerMixpanelCommand(pi: ExtensionAPI, core: MixpanelCore = mixpanelCore): void {
	pi.registerCommand("mixpanel", {
		description: "Sign in to Mixpanel, sign out, or show plugin status",
		getArgumentCompletions: prefix => {
			const separator = prefix.lastIndexOf(" ");
			if (separator >= 0) {
				const command = prefix.slice(0, separator).trim().toLowerCase();
				const regionPrefix = prefix.slice(separator + 1).trim().toLowerCase();
				if (command !== "login" || /\s/u.test(regionPrefix)) return null;
				const matches = MIXPANEL_REGIONS.filter(region => region.startsWith(regionPrefix));
				return matches.length > 0 ? matches.map(region => ({ value: region, label: region })) : null;
			}
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter(subcommand => subcommand.startsWith(normalized));
			return matches.length > 0 ? matches.map(subcommand => ({ value: subcommand, label: subcommand })) : null;
		},
		handler: (args, ctx) => handleMixpanelCommand(args, ctx, core),
	});
}
