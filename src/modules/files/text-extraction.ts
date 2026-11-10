import { inflateRawSync, inflateSync } from 'node:zlib';

/**
 * Bounded, dependency-free text extraction for uploaded files.
 *
 * Phase 18 requires searchable text, PDF, and Word content. Files arrive as an
 * in-memory buffer during upload, so the extractor runs synchronously and is
 * deliberately conservative:
 *
 * - Plain text formats are decoded directly.
 * - DOCX (`word/document.xml`) is read from the ZIP container. Stored and
 *   deflated entries are supported; every read is bounded to prevent archive
 *   and decompression bombs.
 * - PDF text is recovered from uncompressed and FlateDecode content streams by
 *   reading the standard text-showing operators. Scanned/image-only PDFs have
 *   no text layer and are not OCR'd.
 * - Legacy binary formats (`.doc`, `.xls`, `.ppt`) and office formats other
 *   than DOCX are not parsed; their filename and metadata remain searchable.
 *
 * Extraction failure must never fail an upload, so every parser returns `null`
 * instead of throwing on malformed input.
 */

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/rtf',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.log',
  '.html',
  '.htm',
  '.sql',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.scss',
  '.env',
  '.ini',
  '.toml',
  '.cfg',
  '.conf',
  '.rtf',
]);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';

/** Uploads above this size are not parsed; the body is kept in object storage. */
const MAX_EXTRACT_BYTES = 25_000_000;
/** Maximum decompressed XML / PDF stream size per entry. */
const MAX_INFLATED_BYTES = 8_000_000;
/** Maximum characters stored on the file record. */
const MAX_EXTRACT_CHARS = 200_000;

export function isTextLikeFile(fileName: string, mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (TEXT_MIME_TYPES.has(mimeType.toLowerCase())) return true;
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot >= 0 && TEXT_EXTENSIONS.has(lower.slice(dot));
}

function extension(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot) : '';
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const point = Number(code);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : '';
    })
    .replace(/&amp;/g, '&');
}

function normalizeText(value: string): string | null {
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;
  return text.slice(0, MAX_EXTRACT_CHARS);
}

function readUInt16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;

/**
 * Locate and extract one file from a ZIP archive. Only the central directory is
 * trusted for sizes, and inflated output is capped.
 */
function readZipEntry(buffer: Buffer, wantedName: string): Buffer | null {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buffer.length) return null;
  if (readUInt32(buffer, eocd) !== ZIP_EOCD_SIGNATURE) return null;

  const entryCount = readUInt16(buffer, eocd + 10);
  const directoryOffset = readUInt32(buffer, eocd + 16);
  if (directoryOffset >= buffer.length) return null;

  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length) return null;
    if (readUInt32(buffer, offset) !== ZIP_CENTRAL_SIGNATURE) return null;

    const method = readUInt16(buffer, offset + 10);
    const compressedSize = readUInt32(buffer, offset + 20);
    const uncompressedSize = readUInt32(buffer, offset + 24);
    const nameLength = readUInt16(buffer, offset + 28);
    const extraLength = readUInt16(buffer, offset + 30);
    const commentLength = readUInt16(buffer, offset + 32);
    const localOffset = readUInt32(buffer, offset + 42);
    const nameStart = offset + 46;
    if (nameStart + nameLength > buffer.length) return null;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);

    if (name === wantedName) {
      if (uncompressedSize > MAX_INFLATED_BYTES) return null;
      if (localOffset + 30 > buffer.length) return null;
      if (readUInt32(buffer, localOffset) !== ZIP_LOCAL_SIGNATURE) return null;
      const localNameLength = readUInt16(buffer, localOffset + 26);
      const localExtraLength = readUInt16(buffer, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > buffer.length) return null;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);

      if (method === 0) return Buffer.from(data);
      if (method === 8) {
        try {
          return inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES });
        } catch {
          return null;
        }
      }
      return null;
    }

    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return null;
}

function xmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<w:cr\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replaceAll('\u0000', '');
}

function extractDocxText(buffer: Buffer): string | null {
  const documentXml = readZipEntry(buffer, 'word/document.xml');
  if (!documentXml) return null;
  return normalizeText(decodeXmlEntities(xmlToText(documentXml.toString('utf8'))));
}

function decodePdfLiteralString(raw: string): string {
  let value = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char !== '\\') {
      value += char;
      continue;
    }
    const next = raw[index + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let octal = next;
      index += 1;
      for (let count = 0; count < 2 && index + 1 < raw.length; count += 1) {
        const digit = raw[index + 1]!;
        if (digit < '0' || digit > '7') break;
        octal += digit;
        index += 1;
      }
      value += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
      continue;
    }
    const escaped: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      '(': '(',
      ')': ')',
      '\\': '\\',
    };
    value += escaped[next] ?? next;
    index += 1;
  }
  return value;
}

/** Read text-showing operators from a decoded PDF content stream. */
function extractPdfContentText(content: string): string {
  let output = '';
  let index = 0;
  while (index < content.length) {
    const char = content[index]!;

    if (char === '(') {
      let depth = 1;
      let cursor = index + 1;
      let literal = '';
      while (cursor < content.length && depth > 0) {
        const current = content[cursor]!;
        if (current === '\\') {
          literal += current;
          if (cursor + 1 < content.length) literal += content[cursor + 1]!;
          cursor += 2;
          continue;
        }
        if (current === '(') depth += 1;
        if (current === ')') {
          depth -= 1;
          if (depth === 0) {
            cursor += 1;
            break;
          }
        }
        literal += current;
        cursor += 1;
      }
      output += decodePdfLiteralString(literal);
      index = cursor;
      continue;
    }

    if (char === '<' && content[index + 1] !== '<') {
      const end = content.indexOf('>', index);
      if (end > index) {
        const hex = content.slice(index + 1, end).replace(/\s+/g, '');
        if (hex.length % 2 === 0 && /^[0-9a-f]*$/i.test(hex)) {
          for (let cursor = 0; cursor < hex.length; cursor += 2) {
            output += String.fromCharCode(Number.parseInt(hex.slice(cursor, cursor + 2), 16));
          }
        }
        index = end + 1;
        continue;
      }
    }

    if (
      content.startsWith('Td', index) ||
      content.startsWith('TD', index) ||
      content.startsWith('T*', index)
    ) {
      output += '\n';
    }

    index += 1;
  }
  return output;
}

function pdfStreams(buffer: Buffer): string[] {
  const latin = buffer.toString('latin1');
  const streams: string[] = [];
  let searchFrom = 0;

  while (streams.length < 2000) {
    const streamStart = latin.indexOf('stream', searchFrom);
    if (streamStart < 0) break;
    const afterKeyword = streamStart + 'stream'.length;
    const newlineLength = latin.startsWith('\r\n', afterKeyword)
      ? 2
      : latin[afterKeyword] === '\n'
        ? 1
        : 0;
    const dataStart = afterKeyword + newlineLength;
    const end = latin.indexOf('endstream', dataStart);
    if (end < 0) break;

    // The stream dictionary is the object text immediately before `stream`.
    const dictionaryStart = Math.max(0, streamStart - 1500);
    const dictionary = latin.slice(dictionaryStart, streamStart);
    if (dataStart < end) {
      const raw = buffer.subarray(dataStart, end);
      let decoded: Buffer | null = null;
      if (dictionary.includes('/FlateDecode') || dictionary.includes('/Fl ')) {
        try {
          decoded = inflateSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
        } catch {
          try {
            decoded = inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
          } catch {
            decoded = null;
          }
        }
      } else if (!dictionary.includes('/Filter')) {
        decoded = raw;
      }
      if (decoded) streams.push(decoded.toString('latin1'));
    }

    searchFrom = end + 'endstream'.length;
  }

  return streams;
}

function extractPdfText(buffer: Buffer): string | null {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
  const streams = pdfStreams(buffer);
  if (streams.length === 0) return null;
  const text = streams.map(extractPdfContentText).join('\n');
  return normalizeText(text);
}

export function extractTextFromUpload(
  fileName: string,
  mimeType: string,
  body: Buffer,
): string | null {
  if (body.length === 0 || body.length > MAX_EXTRACT_BYTES) return null;

  try {
    const normalizedMime = mimeType.toLowerCase();

    if (normalizedMime === DOCX_MIME || extension(fileName) === '.docx') {
      return extractDocxText(body);
    }

    if (normalizedMime === PDF_MIME || extension(fileName) === '.pdf') {
      return extractPdfText(body);
    }

    if (!isTextLikeFile(fileName, mimeType)) return null;
    // A NUL byte is a strong signal that the payload is binary despite its name.
    if (body.includes(0)) return null;
    return normalizeText(body.toString('utf8'));
  } catch {
    // Extraction is a convenience. A malformed file must not break the upload.
    return null;
  }
}
