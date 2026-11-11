import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";
import { generateSecret, generateURI, verifySync } from "otplib";
import { config } from "../config.js";

const BCRYPT_ROUNDS = 12;
export const hashPassword = (p: string) => bcrypt.hash(p, BCRYPT_ROUNDS);
export const verifyPassword = (p: string, h: string) => bcrypt.compare(p, h);

/** Password policy: min length from tenant settings + at least 3 of 4 character classes. */
export function passwordProblems(p: string, minLength: number): string[] {
  const out: string[] = [];
  if (p.length < minLength) out.push(`min_length_${minLength}`);
  if (p.length > 128) out.push("max_length_128");
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (classes < 3) out.push("needs_3_of_lower_upper_digit_symbol");
  return out;
}

export interface AccessClaims { sub: string; tid: string; typ: "access" }
export interface PlatformClaims { sub: string; typ: "platform" }

export const signAccess = (userId: string, tenantId: string, ttlSec = config.accessTokenTtlSec) =>
  jwt.sign({ tid: tenantId, typ: "access" }, config.jwtSecret, { subject: userId, expiresIn: ttlSec, algorithm: "HS256", issuer: "golden-erp" });
export const signPlatform = (platformUserId: string) =>
  jwt.sign({ typ: "platform" }, config.platformJwtSecret, { subject: platformUserId, expiresIn: config.accessTokenTtlSec, algorithm: "HS256", issuer: "golden-erp-platform" });

export function verifyAccess(token: string): AccessClaims | null {
  try {
    const c = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], issuer: "golden-erp" }) as any;
    return c.typ === "access" && c.tid && c.sub ? c : null;
  } catch { return null; }
}
export function verifyPlatform(token: string): PlatformClaims | null {
  try {
    const c = jwt.verify(token, config.platformJwtSecret, { algorithms: ["HS256"], issuer: "golden-erp-platform" }) as any;
    return c.typ === "platform" && c.sub ? c : null;
  } catch { return null; }
}

export const newOpaqueToken = () => randomBytes(32).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const newTotpSecret = () => generateSecret();
export const totpUri = (secret: string, label: string) => generateURI({ issuer: "GOLDEN ERP", label, secret });
export function verifyTotp(secret: string, token: string): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  try { return verifySync({ secret, token, epochTolerance: 30 }).valid; } catch { return false; }
}

/** Valid bcrypt hash of a random string: compared against when the user does not exist, to equalize timing. */
export const DUMMY_HASH = "$2b$12$wlQKmIfDzSyXsHYknpW2Au0DPXNDwiAUobeOsjzw.eGIOvx/S4dUy";
