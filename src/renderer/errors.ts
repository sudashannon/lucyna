export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^(?:Error: )?Error invoking remote method '[^']+':\s*(?:Error: )?/, '')
    .replace(/^Error:\s*/, '');
}
