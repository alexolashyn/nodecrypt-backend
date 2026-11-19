export function writeJsonLine(record: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`,
  );
}

export const roundMs = (ms: number) => Math.round(ms * 1000) / 1000;
