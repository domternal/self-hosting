import { closeSync, openSync, readSync } from 'node:fs';

const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4 * 1024;

function hasAsciiControl(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Read a secret from NAME or NAME_FILE without ever including the value in an
 * error. Empty direct values count as unset so Compose can pass an empty
 * compatibility variable while a mounted secret file supplies the value.
 * One or more final line endings are removed from files because `echo secret`
 * is the common way operators create them; embedded line endings are kept.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {{ maxBytes?: number }} [options]
 */
export function readSecretSetting(env, name, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('readSecretSetting: maxBytes must be a positive safe integer.');
  }

  const direct = env[name] ?? '';
  const fileName = `${name}_FILE`;
  const file = env[fileName] ?? '';
  const hasDirect = direct !== '';
  const hasFile = file !== '';

  if (hasDirect && hasFile) {
    throw new Error(`${name} and ${fileName} are both set; use exactly one.`);
  }
  if (!hasFile) {
    validateSecretText(name, direct, maxBytes);
    return direct;
  }

  if (hasAsciiControl(file) || Buffer.byteLength(file, 'utf8') > MAX_PATH_BYTES) {
    throw new Error(`${fileName} is not a valid secret-file path.`);
  }

  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > maxBytes) {
      throw new Error(`${fileName} exceeds the ${String(maxBytes)} byte limit.`);
    }

    let value;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    } catch {
      throw new Error(`${fileName} must contain valid UTF-8 text.`);
    }
    value = value.replace(/(?:\r\n|\n|\r)+$/u, '');
    validateSecretText(fileName, value, maxBytes);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(fileName)) throw error;
    throw new Error(`${fileName} could not be read.`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateSecretText(name, value, maxBytes) {
  if (value.includes('\0')) throw new Error(`${name} must not contain NUL bytes.`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${name} exceeds the ${String(maxBytes)} byte limit.`);
  }
}
