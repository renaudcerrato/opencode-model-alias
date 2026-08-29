/**
 * Jest global setup.
 *
 * The plugin resolves its alias file relative to the opencode config dir,
 * which depends on OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME. CI runners (and
 * some dev machines) export XDG_CONFIG_HOME, which would make the plugin
 * resolve a different path than the tests' mocked homedir-based ALIAS_FILE.
 *
 * Pin the environment so path resolution is deterministic everywhere:
 * the plugin falls back to homedir()/.config, matching the test mock
 * (`homedir: () => "/home/test"`).
 */
delete process.env.OPENCODE_CONFIG_DIR;
delete process.env.XDG_CONFIG_HOME;