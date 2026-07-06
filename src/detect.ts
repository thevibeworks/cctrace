import { openSync, readSync, closeSync, readFileSync } from "fs";

export function isNativeBinary(filePath: string): boolean {
  try {
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);

    // ELF
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
    // Mach-O (all variants)
    if (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa) return true;
    if (buf[0] === 0xce && buf[1] === 0xfa && buf[2] === 0xed) return true;
    if (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed) return true;
    if (buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba) return true;
    // PE (Windows)
    if (buf[0] === 0x4d && buf[1] === 0x5a) return true;

    return false;
  } catch {
    return false;
  }
}

export function resolveClaudeBashWrapper(claudePath: string): string | null {
  try {
    const content = readFileSync(claudePath, "utf-8");
    if (content.startsWith("#!/bin/bash") || content.startsWith("#!/bin/sh")) {
      const execMatch = content.match(/exec\s+"([^"]+)"/);
      if (execMatch?.[1]) return execMatch[1];
    }
  } catch { /* not a text file */ }
  return null;
}
