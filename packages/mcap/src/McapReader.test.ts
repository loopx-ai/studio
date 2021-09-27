// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { crc32 } from "@foxglove/crc";

import McapReader from "./McapReader";
import { MCAP_MAGIC, RecordType } from "./constants";

function uint32LE(n: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, n, true);
  return result;
}
function uint64LE(n: bigint): Uint8Array {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, n, true);
  return result;
}
function string(str: string): Uint8Array {
  const encoded = new TextEncoder().encode(str);
  const result = new Uint8Array(4 + encoded.length);
  new DataView(result.buffer).setUint32(0, encoded.length, true);
  result.set(encoded, 4);
  return result;
}
function record(type: RecordType, data: number[]): Uint8Array {
  if (type === RecordType.FOOTER) {
    const result = new Uint8Array(1 + data.length);
    result[0] = type;
    result.set(data, 1);
    return result;
  }
  const result = new Uint8Array(5 + data.length);
  result[0] = type;
  new DataView(result.buffer).setUint32(1, data.length, true);
  result.set(data, 5);
  return result;
}

const formatVersion = 1;

describe("McapReader", () => {
  it("rejects invalid header", () => {
    for (let i = 0; i < MCAP_MAGIC.length - 1; i++) {
      const reader = new McapReader();
      const badMagic = MCAP_MAGIC.slice();
      badMagic[i] = 0x00;
      reader.append(new Uint8Array([...badMagic, formatVersion]));
      expect(() => reader.nextRecord()).toThrow("Expected MCAP magic");
    }
  });

  it("rejects invalid footer magic", () => {
    const reader = new McapReader();
    reader.append(
      new Uint8Array([
        ...MCAP_MAGIC,
        formatVersion,
        ...record(RecordType.FOOTER, [
          ...uint64LE(0x0123456789abcdefn), // index pos
          ...uint32LE(0x01234567), // index crc
        ]),
        ...MCAP_MAGIC.slice(0, MCAP_MAGIC.length - 1),
        0x00,
        formatVersion,
      ]),
    );
    expect(() => reader.nextRecord()).toThrow("Expected MCAP magic");
  });

  it("parses empty file", () => {
    const reader = new McapReader();
    reader.append(
      new Uint8Array([
        ...MCAP_MAGIC,
        formatVersion,
        ...record(RecordType.FOOTER, [
          ...uint64LE(0x0123456789abcdefn), // index pos
          ...uint32LE(0x01234567), // index crc
        ]),
        ...MCAP_MAGIC,
        formatVersion,
      ]),
    );
    expect(reader.nextRecord()).toEqual({
      type: "Footer",
      indexPos: 0x0123456789abcdefn,
      indexCrc: 0x01234567,
    });
    expect(reader.done()).toBe(true);
  });

  it("waits patiently to parse one byte at a time, and rejects new data after read completed", () => {
    const reader = new McapReader();
    const data = new Uint8Array([
      ...MCAP_MAGIC,
      formatVersion,
      ...record(RecordType.FOOTER, [
        ...uint64LE(0x0123456789abcdefn), // index pos
        ...uint32LE(0x01234567), // index crc
      ]),
      ...MCAP_MAGIC,
      formatVersion,
    ]);
    for (let i = 0; i < data.length - 1; i++) {
      reader.append(new Uint8Array(data.buffer, i, 1));
      expect(reader.nextRecord()).toBeUndefined();
      expect(reader.done()).toBe(false);
    }
    reader.append(new Uint8Array(data.buffer, data.length - 1, 1));
    expect(reader.nextRecord()).toEqual({
      type: "Footer",
      indexPos: 0x0123456789abcdefn,
      indexCrc: 0x01234567,
    });
    expect(reader.done()).toBe(true);
    expect(() => reader.append(new Uint8Array([42]))).toThrow("Already done reading");
  });

  it("rejects unknown format version in header", () => {
    const reader = new McapReader();
    reader.append(new Uint8Array([...MCAP_MAGIC, 2]));
    expect(() => reader.nextRecord()).toThrow("Unsupported format version 2");
  });

  it("rejects unknown format version in footer", () => {
    const reader = new McapReader();
    reader.append(
      new Uint8Array([
        ...MCAP_MAGIC,
        formatVersion,
        ...record(RecordType.FOOTER, [
          ...uint64LE(0x0123456789abcdefn), // index pos
          ...uint32LE(0x01234567), // index crc
        ]),
        ...MCAP_MAGIC,
        2,
      ]),
    );
    expect(() => reader.nextRecord()).toThrow("Unsupported format version 2");
  });

  it("rejects extraneous data at end of file", () => {
    const reader = new McapReader();
    reader.append(
      new Uint8Array([
        ...MCAP_MAGIC,
        formatVersion,
        ...record(RecordType.FOOTER, [
          ...uint64LE(0x0123456789abcdefn), // index pos
          ...uint32LE(0x01234567), // index crc
        ]),
        ...MCAP_MAGIC,
        formatVersion,
        42,
      ]),
    );
    expect(() => reader.nextRecord()).toThrow("bytes remaining after MCAP footer");
  });

  it("parses file with empty chunk", () => {
    const reader = new McapReader();
    reader.append(
      new Uint8Array([
        ...MCAP_MAGIC,
        formatVersion,

        ...record(RecordType.CHUNK, [
          ...uint64LE(0n), // decompressed size
          ...uint32LE(0), // decompressed crc32
          ...string(""), // compression
          // (no chunk data)
        ]),

        ...record(RecordType.FOOTER, [
          ...uint64LE(0n), // index pos
          ...uint32LE(0), // index crc
        ]),
        ...MCAP_MAGIC,
        formatVersion,
      ]),
    );
    expect(reader.nextRecord()).toEqual({ type: "Footer", indexPos: 0n, indexCrc: 0 });
    expect(reader.done()).toBe(true);
  });

  it("rejects chunk with incomplete record", () => {
    const reader = new McapReader();
    reader.append(
      new Uint8Array([
        ...MCAP_MAGIC,
        formatVersion,

        ...record(RecordType.CHUNK, [
          ...uint64LE(1n), // decompressed size
          ...uint32LE(crc32(new Uint8Array([RecordType.CHANNEL_INFO]))), // decompressed crc32
          ...string(""), // compression

          RecordType.CHANNEL_INFO, // truncated record
        ]),

        ...record(RecordType.FOOTER, [
          ...uint64LE(0n), // index pos
          ...uint32LE(0), // index crc
        ]),
        ...MCAP_MAGIC,
        formatVersion,
      ]),
    );
    expect(() => reader.nextRecord()).toThrow("bytes remaining in chunk");
  });

  it("parses channel info at top level", () => {
    const reader = new McapReader();
    reader.append(
      new Uint8Array([
        ...MCAP_MAGIC,
        formatVersion,

        ...record(RecordType.CHANNEL_INFO, [
          ...uint32LE(1), // channel id
          ...string("mytopic"), // topic
          ...string("utf12"), // encoding
          ...string("some data"), // schema name
          ...string("none"), // schema format
          ...uint32LE(0), // empty schema
          ...[1, 2, 3], // channel data
        ]),

        ...record(RecordType.FOOTER, [
          ...uint64LE(0n), // index pos
          ...uint32LE(0), // index crc
        ]),
        ...MCAP_MAGIC,
        formatVersion,
      ]),
    );
    expect(reader.nextRecord()).toEqual({
      type: "ChannelInfo",
      id: 1,
      topic: "mytopic",
      encoding: "utf12",
      schemaName: "some data",
      schema: new ArrayBuffer(0),
      data: new Uint8Array([1, 2, 3]).buffer,
    });
    expect(reader.nextRecord()).toEqual({ type: "Footer", indexPos: 0n, indexCrc: 0 });
    expect(reader.done()).toBe(true);
  });

  it.each([true, false])("parses channel info in chunk (compressed: %s)", (compressed) => {
    const channelInfo = record(RecordType.CHANNEL_INFO, [
      ...uint32LE(1), // channel id
      ...string("mytopic"), // topic
      ...string("utf12"), // encoding
      ...string("some data"), // schema name
      ...string("none"), // schema format
      ...uint32LE(0), // empty schema
      ...[1, 2, 3], // channel data
    ]);
    const decompressHandlers = { xyz: () => channelInfo };
    const reader = new McapReader(compressed ? { decompressHandlers } : undefined);
    reader.append(
      new Uint8Array([
        ...MCAP_MAGIC,
        formatVersion,

        ...record(RecordType.CHUNK, [
          ...uint64LE(0n), // decompressed size
          ...uint32LE(crc32(channelInfo)), // decompressed crc32
          ...string(compressed ? "xyz" : ""), // compression
          ...(compressed ? [] : channelInfo),
        ]),

        ...record(RecordType.FOOTER, [
          ...uint64LE(0n), // index pos
          ...uint32LE(0), // index crc
        ]),
        ...MCAP_MAGIC,
        formatVersion,
      ]),
    );
    expect(reader.nextRecord()).toEqual({
      type: "ChannelInfo",
      id: 1,
      topic: "mytopic",
      encoding: "utf12",
      schemaName: "some data",
      schema: new ArrayBuffer(0),
      data: new Uint8Array([1, 2, 3]).buffer,
    });
    expect(reader.nextRecord()).toEqual({ type: "Footer", indexPos: 0n, indexCrc: 0 });
    expect(reader.done()).toBe(true);
  });
});
