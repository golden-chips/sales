import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
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

// ------------------------------------------------------------------ secrets at rest (K3)
// AES-256-GCM. Stored as "enc1:<iv>:<tag>:<ciphertext>" (base64url). Values written before 0.9 are
// plain text and are still read; they are re-encrypted the next time they are used.
let dataKey: Buffer | null = null;
const key = () => (dataKey ??= config.dataEncryptionKey
  ? createHash("sha256").update(config.dataEncryptionKey).digest()
  : Buffer.from(hkdfSync("sha256", config.jwtSecret, "golden-erp", "data-encryption-v1", 32)));
export const isEncrypted = (v: string | null | undefined) => !!v && v.startsWith("enc1:");
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `enc1:${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
}
/** null when the value cannot be decrypted (wrong key / tampered) */
export function decryptSecret(v: string | null | undefined): string | null {
  if (!v) return null;
  if (!isEncrypted(v)) return v;
  const [, iv, tag, ct] = v.split(":");
  try {
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch { return null; }
}

export const newTotpSecret = () => generateSecret();
export const totpUri = (secret: string, label: string) => generateURI({ issuer: "GOLDEN ERP", label, secret });
/** `secret` may be stored encrypted or (before 0.9) in plain text */
export function verifyTotp(stored: string, token: string): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const secret = decryptSecret(stored);
  if (!secret) return false;
  try { return verifySync({ secret, token, epochTolerance: 30 }).valid; } catch { return false; }
}

/** Valid bcrypt hash of a random string: compared against when the user does not exist, to equalize timing. */
export const DUMMY_HASH = "$2b$12$wlQKmIfDzSyXsHYknpW2Au0DPXNDwiAUobeOsjzw.eGIOvx/S4dUy";
