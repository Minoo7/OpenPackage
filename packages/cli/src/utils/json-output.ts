/**
 * Shared JSON output utility for CLI commands.
 * Single source of truth for all --json output across every command.
 */

/**
 * Print data as formatted JSON to stdout.
 * Uses 2-space indent for readability.
 */
export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Print a success envelope: { success: true, data: T, warnings?: string[] }
 */
export function printJsonSuccess<T>(data: T, warnings?: string[]): void {
  const result: Record<string, unknown> = { success: true, data };
  if (warnings?.length) result.warnings = warnings;
  printJson(result);
}

/**
 * Print an error envelope: { success: false, data: null, error: string, warnings?: string[] }
 * Also sets process.exitCode = 1.
 */
export function printJsonError(error: string, warnings?: string[]): void {
  const result: Record<string, unknown> = { success: false, data: null, error };
  if (warnings?.length) result.warnings = warnings;
  printJson(result);
  process.exitCode = 1;
}
