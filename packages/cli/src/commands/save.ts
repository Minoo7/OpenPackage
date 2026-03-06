/**
 * Save Command (deprecated)
 *
 * The save command has been replaced by `sync --push`.
 * This stub prints a deprecation notice for any invocation.
 */

export async function setupSaveCommand(): Promise<void> {
  console.log(
    `The save command has been deprecated. Use 'opkg sync --push' instead.\n` +
    `  opkg sync --push [target]    Push workspace edits to source\n` +
    `  opkg sync --push             Push all modified packages`,
  );
}
