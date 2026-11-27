// Lines of T3 Code 0.1.14-nightly.20261127.5332's apps/desktop/dist-electron/main.cjs (MIT), cut for tests.
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
function getAutoUpdateDisabledReason(args) {
	if (args.policy.mode === "off") return args.policy.message ?? "Updates are turned off on this machine.";
	if (!args.hasUpdateFeedConfig) return "Automatic updates are not available because no update feed is configured.";
	if (args.isDevelopment || !args.isPackaged) return "Automatic updates are only available in packaged production builds.";
	if (args.disabledByEnv) return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
	if (args.platform === "linux" && !args.appImage && !args.isDebPackage) return "Automatic updates on Linux require the AppImage or the .deb package.";
	return null;
}
const handleCheckForUpdatesMenuClick = gen(function* () {
	const updates = yield* DesktopUpdates;
	const electronDialog = yield* ElectronDialog;
	// …
});
const make$12 = gen(function* () {
	const fileSystem = yield* FileSystem;
	const desktopSettings = yield* DesktopAppSettings;
	const policy = yield* DesktopUpdatePolicy;
	const mockUpdates = config.mockUpdates && policy.message === null;
	// …
});
