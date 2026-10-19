export const MAX_BYTES = 512 * 1024;
export function encode(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_BYTES) throw new Error('Message too large');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export function decoder(onMessage, onError) {
  let buffer = Buffer.alloc(0), failed = false;
  return chunk => {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        if (!size || size > MAX_BYTES) throw new Error('Invalid frame size');
        if (buffer.length < size + 4) return;
        const message = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        onMessage(message);
      }
    } catch (error) { failed = true; onError(error); }
  };
}
