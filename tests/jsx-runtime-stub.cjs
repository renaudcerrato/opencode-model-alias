// CJS stub of @opentui/solid's JSX runtime for jest.
// The real runtime is ESM-only; tests never render JSX. The TUI plugin's
// dialogs are component functions passed as the JSX "type" — invoking them
// with their props (what a renderer would do) is how the tests drive the
// flows: the plugin's DialogSelect/DialogPrompt factories record their props
// when called, and those props are what the tests assert on.
function invoke(type, props) {
	if (typeof type === "function") {
		return type(props);
	}
	return {};
}

module.exports = {
	jsx: invoke,
	jsxs: invoke,
	jsxDEV: invoke,
	Fragment: Symbol("Fragment"),
};