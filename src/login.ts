import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import type { MixpanelAccount, MixpanelAuthPresenter, MixpanelCore, MixpanelRegion } from "./types";

const LOGIN_LABEL = "Mixpanel";
const MANUAL_INPUT_PROMPT = "Paste the authorization code (or full redirect URL):";
const MANUAL_INPUT_PLACEHOLDER = "http://localhost:3000/callback?code=…";

/** Present Mixpanel OAuth through the same TUI and paste-back flow as OMP's built-in logins. */
export async function runMixpanelLogin(
	ctx: ExtensionContext,
	core: MixpanelCore,
	region?: MixpanelRegion,
	signal?: AbortSignal,
): Promise<MixpanelAccount> {
	if (ctx.mode === "tui") return loginInDialog(ctx, core, region, signal);
	if (!ctx.hasUI) throw new Error("Mixpanel sign-in needs an interactive OMP session; run `/mixpanel login` there.");

	const presenter: MixpanelAuthPresenter = {
		onAuth({ url, launchUrl, instructions }) {
			const lines = ["Open this URL in your browser to sign in to Mixpanel:", url];
			if (launchUrl && launchUrl !== url) lines.push(`Local shortcut (this machine only): ${launchUrl}`);
			if (instructions) lines.push(instructions);
			ctx.ui.notify(lines.join("\n"), "info");
		},
		onProgress: message => ctx.ui.notify(message, "info"),
		async onManualCodeInput(inputSignal) {
			const value = await ctx.ui.input(MANUAL_INPUT_PROMPT, MANUAL_INPUT_PLACEHOLDER, {
				...(inputSignal ? { signal: inputSignal } : {}),
			});
			if (value === undefined) throw new LoginCancelledError();
			return value;
		},
		...(signal ? { signal } : {}),
	};
	return core.login(presenter, region);
}

async function loginInDialog(
	ctx: ExtensionContext,
	core: MixpanelCore,
	region?: MixpanelRegion,
	signal?: AbortSignal,
): Promise<MixpanelAccount> {
	const mounted = Promise.withResolvers<{ dialog: LoginDialogComponent; close: () => void }>();
	const shown = ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
		const dialog = new LoginDialogComponent(tui, LOGIN_LABEL, () => done(), openPath);
		mounted.resolve({ dialog, close: () => done() });
		return dialog;
	});
	const { dialog, close } = await Promise.race([
		mounted.promise,
		shown.then(() => {
			throw new Error("The Mixpanel sign-in dialog could not be shown.");
		}),
	]);
	try {
		return await core.login(
			{
				signal: signal ? AbortSignal.any([dialog.signal, signal]) : dialog.signal,
				onAuth: info => dialog.showAuth(info.url, info.instructions, info.launchUrl),
				onProgress: message => dialog.showProgress(message),
				onManualCodeInput: inputSignal => dialog.showManualInput(MANUAL_INPUT_PROMPT, inputSignal),
			},
			region,
		);
	} catch (error) {
		if (dialog.signal.aborted) throw new LoginCancelledError();
		throw error;
	} finally {
		close();
		await shown;
	}
}
