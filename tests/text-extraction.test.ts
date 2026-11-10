import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';
import test from 'node:test';
import { extractTextFromUpload, isTextLikeFile } from '../src/modules/files/text-extraction';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(name: string, content: string, method: 0 | 8): Buffer {
  const nameBuffer = Buffer.from(name, 'utf8');
  const raw = Buffer.from(content, 'utf8');
  const data = method === 8 ? deflateRawSync(raw) : raw;
  const checksum = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + nameBuffer.length + data.length;
  const centralRecord = Buffer.concat([central, nameBuffer]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, nameBuffer, data, centralRecord, eocd]);
}

function pdfWithStream(streamBody: string, flate: boolean): Buffer {
  const raw = Buffer.from(streamBody, 'latin1');
  const data = flate ? deflateSync(raw) : raw;
  const header = Buffer.from(
    flate
      ? `%PDF-1.4\n1 0 obj << /Length ${data.length} /Filter /FlateDecode >>\nstream\n`
      : `%PDF-1.4\n1 0 obj << /Length ${data.length} >>\nstream\n`,
    'latin1',
  );
  const footer = Buffer.from('\nendstream\nendobj\ntrailer <<>>\n%%EOF\n', 'latin1');
  return Buffer.concat([header, data, footer]);
}

test('plain text is extracted and normalised', () => {
  const text = extractTextFromUpload(
    'notes.txt',
    'text/plain',
    Buffer.from('Hello\r\n\r\n\r\nWorld  \n'),
  );
  assert.equal(text, 'Hello\n\nWorld');
  assert.equal(isTextLikeFile('notes.txt', 'text/plain'), true);
});

test('stored DOCX content is extracted from word/document.xml', () => {
  const xml =
    '<w:document><w:body><w:p><w:r><w:t>Quarterly</w:t></w:r><w:r><w:t xml:space="preserve"> report</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>&amp; searchable</w:t></w:r></w:p></w:body></w:document>';
  const docx = buildZip('word/document.xml', xml, 0);
  const text = extractTextFromUpload('report.docx', DOCX_MIME, docx);
  assert.match(text ?? '', /Quarterly report/);
  assert.match(text ?? '', /& searchable/);
});

test('deflated DOCX content is extracted', () => {
  const xml =
    '<w:document><w:body><w:p><w:r><w:t>Compressed content</w:t></w:r></w:p></w:body></w:document>';
  const docx = buildZip('word/document.xml', xml, 8);
  assert.equal(extractTextFromUpload('report.docx', DOCX_MIME, docx), 'Compressed content');
});

test('uncompressed PDF text operators are extracted', () => {
  const pdf = pdfWithStream('BT /F1 12 Tf 72 720 Td (Hello Nexus Search) Tj ET', false);
  assert.equal(extractTextFromUpload('doc.pdf', 'application/pdf', pdf), 'Hello Nexus Search');
});

test('FlateDecode PDF content streams are extracted', () => {
  const pdf = pdfWithStream('BT (Compressed PDF text) Tj ET', true);
  assert.equal(extractTextFromUpload('doc.pdf', 'application/pdf', pdf), 'Compressed PDF text');
});

test('PDF string escapes and line movement are handled', () => {
  const pdf = pdfWithStream('BT (Line one) Tj T* (Line \\(two\\)) Tj ET', false);
  const text = extractTextFromUpload('doc.pdf', 'application/pdf', pdf);
  assert.match(text ?? '', /Line one/);
  assert.match(text ?? '', /Line \(two\)/);
});

test('binary and unsupported formats are not parsed', () => {
  assert.equal(
    extractTextFromUpload('photo.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0])),
    null,
  );
  assert.equal(
    extractTextFromUpload('legacy.doc', 'application/msword', Buffer.from('binary')),
    null,
  );
  assert.equal(
    extractTextFromUpload('broken.pdf', 'application/pdf', Buffer.from('not a pdf')),
    null,
  );
  assert.equal(extractTextFromUpload('broken.docx', DOCX_MIME, Buffer.from('not a zip')), null);
});

test('a malformed compressed stream does not throw', () => {
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Filter /FlateDecode >>\nstream\n', 'latin1'),
    Buffer.from([0x00, 0xff, 0x13]),
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
  assert.equal(extractTextFromUpload('broken.pdf', 'application/pdf', pdf), null);
});
