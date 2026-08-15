const { unzipSync, strFromU8 } = require('fflate');
const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function columnIndex(reference) {
  const letters = String(reference || '').match(/[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) return -1;
  return [...letters].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function sharedStrings(zip) {
  if (!zip['xl/sharedStrings.xml']) return [];
  const parsed = xmlParser.parse(strFromU8(zip['xl/sharedStrings.xml']));
  return asArray(parsed.sst?.si).map((entry) => {
    if (typeof entry === 'string') return entry;
    if (typeof entry.t === 'string') return entry.t;
    return asArray(entry.r).map((part) => part.t || '').join('');
  });
}

function cellValue(cell, strings) {
  const value = cell.v ?? '';
  if (cell['@_t'] === 's') return strings[Number(value)] || '';
  if (cell['@_t'] === 'b') return String(value) === '1';
  return value;
}

function readXlsxRows(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const sheetXml = zip['xl/worksheets/sheet1.xml'];
  if (!sheetXml) throw new Error('The workbook does not contain a first worksheet');
  const parsed = xmlParser.parse(strFromU8(sheetXml));
  const strings = sharedStrings(zip);
  return asArray(parsed.worksheet?.sheetData?.row).map((row) => {
    const values = [];
    asArray(row.c).forEach((cell) => { values[columnIndex(cell['@_r'])] = cellValue(cell, strings); });
    return values;
  });
}

module.exports = { readXlsxRows };
