import { AssertionError } from "assert";
import { DNSLabelCoder } from "./DNSLabelCoder";
import { DNSPacket } from "./DNSPacket";
import { Question } from "./Question";
import { ResourceRecord } from "./ResourceRecord";

export function runRecordEncodingTest(record: Question | ResourceRecord, legacyUnicast = false): void {
  const coder = new DNSLabelCoder();
  record.trackNames(coder, legacyUnicast);
  coder.computeCompressionPaths();

  const length = record.getEncodingLength(coder);
  const buffer = Buffer.alloc(length);
  coder.initBuf(buffer);

  const written = record.encode(coder, buffer, 0);
  coder.resetCoder();
  expect(written).toBe(buffer.length);

  coder.initBuf(buffer);

  const decodedRecord = record instanceof Question
    ? Question.decode(coder, buffer, 0)
    : ResourceRecord.decode(coder, buffer, 0);
  expect(decodedRecord.readBytes).toBe(buffer.length);

  //
  const record2 = decodedRecord.data;

  const coder2 = new DNSLabelCoder();
  record2.trackNames(coder2, legacyUnicast);
  coder2.computeCompressionPaths();

  const length2 = record2.getEncodingLength(coder2);
  const buffer2 = Buffer.allocUnsafe(length2);
  coder2.initBuf(buffer2);

  const written2 = record2.encode(coder2, buffer2, 0);
  coder2.resetCoder();
  expect(written2).toBe(buffer2.length);

  expect(buffer2).toEqual(buffer);
  expect(record2).toEqual(record);

  if (record2 instanceof ResourceRecord && record instanceof ResourceRecord) {
    // test the equals method
    expect(record2.aboutEqual(record)).toBe(true);

    // test the clone method
    const clone = record.clone();
    record2.clearNameTracking();
    expect(clone).toEqual(record2);
    expect(clone.aboutEqual(record2)).toBe(true);
  }
}

const empty = Buffer.allocUnsafe(0);

export function runCompressionSanityChecks(record: ResourceRecord | Question): void {
  const coder = new DNSLabelCoder();

  expect(() => record.getEncodingLength(coder)).toThrow(AssertionError);
  expect(() => record.encode(coder, empty, 0)).toThrow(AssertionError);
  if (record instanceof ResourceRecord) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    expect(() => record.getRDataEncodingLength(coder)).toThrow(AssertionError);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    expect(() => record.encodeRData(coder, empty, 0)).toThrow(AssertionError);
  }
}

export function runPacketEncodingTest(packet: DNSPacket): void {
  const buffer = packet.encode();
  const decodedPacket = DNSPacket.decode(buffer);

  const buffer2 = decodedPacket.encode();

  expect(buffer).toEqual(buffer2);
  expect(decodedPacket).toEqual(packet);
}
