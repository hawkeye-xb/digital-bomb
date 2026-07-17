// ─── 输入校验 ───

export const VALID_NAME_RE = /^[^\s]{1,16}$/;
export const VALID_GUESS_RE = /^\d{4}$/;

export function isValidName(name: unknown): name is string {
  return typeof name === "string" && VALID_NAME_RE.test(name);
}

export function isValidGuess(input: unknown): input is string {
  return typeof input === "string" && VALID_GUESS_RE.test(input);
}

export function isValidSecret(input: unknown): input is string {
  return isValidGuess(input); // 相同规则：四位数字
}

export function isValidRoomCode(input: unknown): input is string {
  return typeof input === "string" && /^[A-HJ-NP-Z2-9]{6}$/.test(input);
}

// ─── 错误工厂 ───

import type { DomainErrorCode } from "./protocol.js";

export class DomainError extends Error {
  constructor(
    public code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
