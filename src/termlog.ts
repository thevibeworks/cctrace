// Terminal-output guard for live captures. Once the traced client is
// spawned with stdio "inherit" it owns the terminal — a TUI (claude's
// default) repaints the whole screen, and any line cctrace prints lands in
// the middle of it as corruption. So capture runs mute the terminal between
// spawn and child exit: lines buffer here and flush after the client
// releases the screen. Outside a mute window writes pass straight through.
let muted = false;
let buffer: string[] = [];

export function muteTerm(): void {
  muted = true;
}

/** Stop buffering and return what accumulated (caller decides how to print). */
export function unmuteTerm(): string[] {
  muted = false;
  const held = buffer;
  buffer = [];
  return held;
}

export function isTermMuted(): boolean {
  return muted;
}

export function termWrite(line: string): void {
  if (muted) buffer.push(line);
  else console.log(line);
}
