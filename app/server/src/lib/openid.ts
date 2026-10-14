import { randomBytes } from "node:crypto";

/**
 * 内部 OpenID 的生成（#226）。
 *
 * 第三方渠道 id 只是凭据，内部 OpenID 才是身份，所以它必须**随机生成**、不含任何用户信息、
 * 也不能用自增或渠道 id（否则可被枚举）。这里用 ULID 布局：48 位毫秒时间戳 + 80 位随机，
 * Crockford Base32 编成 26 个字符——同一个毫秒内的多个 id 不保证顺序，但整体按时间有序。
 * 纯函数，时钟与随机源都可注入，tests/server 直接测。
 */

/** Crockford Base32：去掉容易看错的 I、L、O、U。 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 时间戳部分占 10 个字符（48 位毫秒，最高两位补零）。 */
const TIME_LENGTH = 10;
/** 随机部分占 16 个字符（80 位）。 */
const RANDOM_LENGTH = 16;
/** OpenID 的总字符数。 */
export const OPENID_LENGTH = TIME_LENGTH + RANDOM_LENGTH;
/** ULID 时间戳的上限（48 位），超过会使整个标识超出 128 位。 */
const MAX_TIMESTAMP = 2 ** 48 - 1;

export function newOpenId(now: number = Date.now(), random: (size: number) => Buffer = randomBytes): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIMESTAMP) throw new Error("openid 时间戳必须是 0 到 2^48-1 之间的整数");
  let time = "";
  let rest = now;
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    time = ALPHABET[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  // 10 字节 = 80 位，正好整除成 16 个 5 位字符；用 BigInt 只为把 80 位装得下。
  const bytes = random(10);
  if (bytes.length !== 10) throw new Error("openid 随机源必须返回 10 字节");
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let suffix = "";
  for (let index = 0; index < RANDOM_LENGTH; index += 1) {
    suffix = ALPHABET[Number(bits & 31n)] + suffix;
    bits >>= 5n;
  }
  return time + suffix;
}
