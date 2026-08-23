'use strict';
// Minimal protobuf encoder/decoder - just enough for Spotify's canvaz-cache endpoint.
// No dependencies: we only need length-delimited strings and nested messages.

function varint(n) {
  const bytes = [];
  while (n > 127) { bytes.push((n & 0x7f) | 0x80); n >>>= 7; }
  bytes.push(n);
  return Buffer.from(bytes);
}

function tag(field, wire) { return varint((field << 3) | wire); }

function encString(field, str) {
  const v = Buffer.from(str, 'utf8');
  return Buffer.concat([tag(field, 2), varint(v.length), v]);
}

function encMessage(field, buf) {
  return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
}

// Decode a buffer into { [fieldNumber]: [values...] }.
// Length-delimited values are returned as Buffers so callers can recurse or toString.
function decode(buf) {
  const out = {};
  let i = 0;
  const readVarint = () => {
    let result = 0, shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  };
  const push = (f, v) => { (out[f] || (out[f] = [])).push(v); };

  while (i < buf.length) {
    const key = readVarint();
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) push(field, readVarint());
    else if (wire === 1) { push(field, buf.slice(i, i + 8)); i += 8; }
    else if (wire === 2) { const len = readVarint(); push(field, buf.slice(i, i + len)); i += len; }
    else if (wire === 5) { push(field, buf.slice(i, i + 4)); i += 4; }
    else throw new Error('unsupported protobuf wire type ' + wire);
  }
  return out;
}

module.exports = { varint, encString, encMessage, decode };
