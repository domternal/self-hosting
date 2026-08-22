const MAX_DOCUMENT_NAME_BYTES = 1_024;

function hasAsciiControl(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * One storage-key contract shared by websocket and REST entry surfaces.
 * Returning a fixed message (never the name) also keeps control characters
 * and oversized attacker input out of logs and authentication errors.
 */
export function documentNameError(name) {
  if (typeof name !== 'string') return 'Document name must be a string';
  if (name.trim() === '') return 'Document name must not be empty';
  if (Buffer.byteLength(name, 'utf8') > MAX_DOCUMENT_NAME_BYTES) {
    return `Document name must be at most ${String(MAX_DOCUMENT_NAME_BYTES)} UTF-8 bytes`;
  }
  if (hasAsciiControl(name)) {
    return 'Document name must not contain control characters';
  }
  if (name.normalize('NFC') !== name) {
    return 'Document name must use Unicode NFC normalization';
  }
  return null;
}
