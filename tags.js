"use strict";

const ContinuumTags = (() => {
  const limit = 24 * 1024 * 1024;
  const utf8 = new TextDecoder();
  const latin = new TextDecoder("iso-8859-1");
  const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourcc = (bytes, offset = 0, length = 4) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const syncSafe = (bytes, offset) => bytes.subarray(offset, offset + 4).reduce((size, byte) => size * 128 + (byte & 127), 0);
  const read = async (file, from, to) => new Uint8Array(await file.slice(from, to).arrayBuffer());
  const clean = (value) => value.replace(/\0+$/g, "").trim();

  function decode(bytes, encoding, inherited) {
    if (encoding === 0) return clean(latin.decode(bytes));
    if (encoding === 3) return clean(utf8.decode(bytes));
    const endian = encoding === 2 || bytes[0] === 254 && bytes[1] === 255 ? "utf-16be"
      : bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" : inherited || "utf-16le";
    return clean(new TextDecoder(endian).decode(bytes));
  }

  function terminator(bytes, start, encoding) {
    const width = encoding === 1 || encoding === 2 ? 2 : 1;
    for (let pos = start; pos + width <= bytes.length; pos += width) {
      if (!bytes[pos] && (width === 1 || !bytes[pos + 1])) return pos + width;
    }
    return bytes.length;
  }

  function image(bytes) {
    if (bytes.length < 12) return undefined;
    const type = bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg"
      : bytes[0] === 137 && fourcc(bytes, 1, 3) === "PNG" ? "image/png"
      : fourcc(bytes, 0, 3) === "GIF" ? "image/gif"
      : fourcc(bytes) === "RIFF" && fourcc(bytes, 8) === "WEBP" ? "image/webp" : "";
    return type ? new Blob([bytes], { type }) : undefined;
  }

  function deunsync(bytes) {
    const result = new Uint8Array(bytes.length);
    let count = 0;
    for (let i = 0; i < bytes.length; i++) {
      result[count++] = bytes[i];
      if (bytes[i] === 255 && bytes[i + 1] === 0) i++;
    }
    return result.subarray(0, count);
  }

  async function id3(file, header) {
    const version = header[3];
    const size = syncSafe(header, 6);
    if (![2, 3, 4].includes(version) || size > limit || size + 10 > file.size || (version === 2 && header[5] & 64)) return {};
    let bytes = await read(file, 10, 10 + size);
    if (version < 4 && header[5] & 128) bytes = deunsync(bytes);
    const data = view(bytes);
    let offset = 0;
    if (version > 2 && header[5] & 64 && bytes.length >= 4) offset = version === 4 ? syncSafe(bytes, 0) : data.getUint32(0) + 4;
    const result = {};
    const length = version === 2 ? 6 : 10;
    while (offset + length <= bytes.length) {
      const key = fourcc(bytes, offset, version === 2 ? 3 : 4);
      if (!/^[A-Z0-9]+$/.test(key)) break;
      const count = version === 2 ? data.getUint32(offset + 2) & 0xffffff
        : version === 4 ? syncSafe(bytes, offset + 4) : data.getUint32(offset + 4);
      const flags = version === 2 ? 0 : bytes[offset + 9];
      const start = offset + length;
      offset = start + count;
      if (!count || offset > bytes.length) break;
      if (flags & (version === 4 ? 0x4d : 0xe0)) continue;
      let frame = bytes.subarray(start, offset);
      if (version === 4 && ((flags & 2) || (header[5] & 128))) frame = deunsync(frame);
      if (!frame.length) continue;
      const encoding = frame[0];
      if (key === "TIT2" || key === "TT2") result.title ||= decode(frame.subarray(1), encoding);
      if (key === "TPE1" || key === "TP1") result.artist ||= decode(frame.subarray(1), encoding);
      if (key === "USLT" || key === "ULT") {
        const end = terminator(frame, 4, encoding);
        const endian = frame[4] === 254 && frame[5] === 255 ? "utf-16be" : "utf-16le";
        result.lyrics ||= decode(frame.subarray(end), encoding, endian);
      }
      if (key === "APIC" || key === "PIC") {
        const typeOffset = key === "PIC" ? 4 : terminator(frame, 1, 0);
        if (!result.art || frame[typeOffset] === 3) {
          result.art = image(frame.subarray(terminator(frame, typeOffset + 1, encoding))) || result.art;
        }
      }
    }
    return result;
  }

  function box(bytes, offset, end) {
    if (offset + 8 > end || offset + 8 > bytes.length) return;
    const data = view(bytes);
    let size = data.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end || offset + 16 > bytes.length) return;
      size = data.getUint32(offset + 8) * 4294967296 + data.getUint32(offset + 12);
      headerSize = 16;
    }
    if (size === 0) size = end - offset;
    if (size < headerSize || size > end - offset) return;
    return { name: fourcc(bytes, offset + 4), start: offset + headerSize, end: offset + size };
  }

  function mp4Items(bytes, start, end, result, depth = 0) {
    if (depth > 5) return;
    const fields = { "©nam": "title", "©ART": "artist", "©lyr": "lyrics" };
    for (let offset = start; offset < end;) {
      const item = box(bytes, offset, end);
      if (!item) break;
      offset = item.end;
      if (["udta", "meta", "ilst"].includes(item.name)) {
        mp4Items(bytes, item.start + (item.name === "meta" ? 4 : 0), item.end, result, depth + 1);
      } else if (item.name === "covr" || fields[item.name]) {
        for (let dataOffset = item.start; dataOffset < item.end;) {
          const data = box(bytes, dataOffset, item.end);
          if (!data) break;
          dataOffset = data.end;
          if (data.name !== "data" || data.start + 8 > data.end) continue;
          const value = bytes.subarray(data.start + 8, data.end);
          if (item.name === "covr") result.art ||= image(value);
          else result[fields[item.name]] ||= clean(utf8.decode(value));
        }
      }
    }
  }

  async function mp4(file) {
    for (let offset = 0, count = 0; offset + 8 <= file.size && count < 256; count++) {
      const header = await read(file, offset, offset + 16);
      const item = box(header, 0, file.size - offset);
      if (!item) break;
      if (item.name === "moov") {
        if (item.end - item.start > limit) return {};
        const bytes = await read(file, offset + item.start, offset + item.end);
        const result = {};
        mp4Items(bytes, 0, bytes.length, result);
        return result;
      }
      offset += item.end;
    }
    return {};
  }

  function flacComments(bytes, result) {
    if (bytes.length < 8) return;
    const data = view(bytes);
    let offset = 4 + data.getUint32(0, true);
    if (offset + 4 > bytes.length) return;
    const count = data.getUint32(offset, true);
    offset += 4;
    for (let i = 0; i < count && offset + 4 <= bytes.length; i++) {
      const size = data.getUint32(offset, true);
      offset += 4;
      if (size > bytes.length - offset) break;
      const comment = utf8.decode(bytes.subarray(offset, offset + size));
      offset += size;
      const match = /^(TITLE|ARTIST|LYRICS|UNSYNCEDLYRICS)=([\s\S]*)$/i.exec(comment);
      if (!match) continue;
      const field = match[1].toLowerCase();
      result[field === "unsyncedlyrics" ? "lyrics" : field] ||= clean(match[2]);
    }
  }

  function flacPicture(bytes, result) {
    if (bytes.length < 32) return;
    const data = view(bytes);
    const type = data.getUint32(0);
    if (result.art && type !== 3) return;
    let offset = 8 + data.getUint32(4);
    if (offset + 4 > bytes.length) return;
    offset += 4 + data.getUint32(offset) + 16;
    if (offset + 4 > bytes.length) return;
    const size = data.getUint32(offset);
    offset += 4;
    if (size <= bytes.length - offset) result.art = image(bytes.subarray(offset, offset + size)) || result.art;
  }

  async function flac(file) {
    const result = {};
    for (let offset = 4, count = 0; offset + 4 <= file.size && count < 128; count++) {
      const header = await read(file, offset, offset + 4);
      const type = header[0] & 127;
      const size = view(header).getUint32(0) & 0xffffff;
      offset += 4;
      if (size > file.size - offset) break;
      if (type === 4 || type === 6) {
        const bytes = await read(file, offset, offset + size);
        if (type === 4) flacComments(bytes, result);
        else flacPicture(bytes, result);
      }
      offset += size;
      if (header[0] & 128) break;
    }
    return result;
  }

  async function parse(file) {
    const header = await read(file, 0, 16);
    if (fourcc(header, 0, 3) === "ID3" && header.length >= 10) return id3(file, header);
    if (fourcc(header) === "fLaC") return flac(file);
    if (fourcc(header, 4) === "ftyp" || /\.(m4a|m4b|mp4)$/i.test(file.name || "")) return mp4(file);
    return {};
  }

  return { parse };
})();
