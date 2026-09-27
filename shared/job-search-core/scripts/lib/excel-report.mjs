import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {SEARCH_MODE} from './search-mode.mjs';
import {SALARY_NOTICE} from './assessment-v5.mjs';

// Resolve the desktop's bundled runtime; do not install or use repo-local packages.
async function loadRuntimePackage(name) {
  const packageRoot = process.env.CODEX_NODE_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
  const require = createRequire(path.join(packageRoot, '__campus_runtime__.cjs'));
  let entry;
  try { entry = require.resolve(name); }
  catch { throw new Error('Excel 导出需要 Codex 附带的 @oai/artifact-tool。请调用 load_workspace_dependencies，并将 CODEX_NODE_MODULES 指向返回的 Node.js packages 目录。'); }
  return import(pathToFileURL(entry).href);
}
export const loadArtifactTool = () => loadRuntimePackage('@oai/artifact-tool');

const COLORS = {header: '#24364B', ink: '#223047', light: '#F4F7FA', line: '#DCE3EB'};
const DEFAULT_FONT = '微软雅黑';
const MAIN_WIDTHS = [18, 25, 18, 42, 16, 24, 28, 16, 16, 20, 230, 48];
export const HEADER_TIPS = Object.freeze({
  '匹配层级': '汇总硬性条件、能力和意愿后的最终分层。硬性条件不符＝本招聘方向的硬性要求与个人条件明确冲突；双向高匹配＝能力高且意愿高；双向有条件匹配＝可以投递但存在可接受的短板；当前匹配不足＝能力或意愿为低；信息待确认＝关键判断信息不足。',
  '意愿匹配度': '岗位是否符合你的求职偏好。高＝重要偏好整体满足；中＝存在可接受的探索或取舍；低＝与明确偏好冲突；待确认／待评估＝关键信息不足或尚未完成评估。',
  '能力匹配度': '你的经历能否支撑岗位核心工作。高＝核心要求有充分直接证据；中＝有可迁移实践但仍有明显缺口；低＝核心要求证据不足；待评估＝尚未完成正式评估。',
  get '硬性条件匹配度'() {return SEARCH_MODE.id==='campus'?'只核对毕业届别和学历。匹配＝明确符合，或JD未写相应限制；不匹配＝任一项与JD明确冲突；待评估＝尚未完成正式评估。硬性条件不匹配时，不建议投递。':(SEARCH_MODE.id==='internship'?'核对学历、在校身份、毕业窗口、开始时间、每周天数和持续时间。':'核对学历、明确要求的工作年限、必需职业资格和硬性到岗时间；不默认要求应届身份。')+'匹配＝符合或未写限制；不匹配＝有明确冲突；待核实＝JD有要求但个人条件尚未确认。';},
});
const SETTINGS = {
  '岗位匹配': {widths: MAIN_WIDTHS, freeze: 3, rowHeight: 36},
  '待核实与未评估': {widths: MAIN_WIDTHS, freeze: 3, rowHeight: 36},
  '来源覆盖': {widths: [22, 20, 16, 16, 20, 70, 24], freeze: 1},
  '公司简介': {widths: [22, 26, 90, 40, 35, 65], freeze: 1},
  '资料复核': {widths: [18, 42, 23, 25, 36, 20, 70, 90, 28, 48], freeze: 2},
  '说明': {widths: [26, 110], freeze: 0},
};
const isNumericText = value => typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value);

function literal(value) {
  if (typeof value !== 'string') return value ?? null;
  const safe = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  if (safe.length > 32767) throw new Error('单元格文字超过 Excel 的 32767 字符上限，请精炼报告摘要；JD 全文应存放在独立归档。');
  // Artifact Tool infers numeric/date strings; preserve identifiers verbatim.
  return safe.startsWith('=') || isNumericText(safe) ? "'" + safe : safe;
}

function wrapLines(value, width) {
  const capacity = Math.max(8, width - 3);
  return String(value ?? '').split('\n').reduce((total, line) => {
    const units = [...line].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
    return total + Math.max(1, Math.ceil(units / capacity));
  }, 0);
}

function formatTable(workbook, sheet, data, index, noteAuthorId) {
  const rowCount = data.rows.length + 1;
  const columnCount = data.headers.length;
  const widths = data.modelVersion===5?[...MAIN_WIDTHS,35,65,60]:SETTINGS[data.name].widths;
  const grid = sheet.getRangeByIndexes(0, 0, rowCount, columnCount);
  grid.values = [data.headers, ...data.rows].map(row => row.map(value => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(value)) return new Date(value);
    return literal(value);
  }));
  grid.format.font = {name: DEFAULT_FONT, size: 11, color: COLORS.ink};
  grid.format.wrapText = true;
  grid.format.verticalAlignment = 'top';
  grid.format.horizontalAlignment = 'left';
  grid.setNumberFormat('@');
  sheet.showGridLines = false;
  sheet.freezePanes.freezeRows(1);
  if (SETTINGS[data.name].freeze) sheet.freezePanes.freezeColumns(SETTINGS[data.name].freeze);
  for (let column = 0; column < columnCount; column++) {
    sheet.getRangeByIndexes(0, column, rowCount, 1).format.columnWidth = widths[column] || 24;
  }
  if (data.rows.length) {
    const table = sheet.tables.add(grid, true, `CampusTable${index + 1}`);
    table.style = 'TableStyleMedium2';
    table.showFilterButton = true;
    for (let i = 0; i < data.rows.length; i++) {
      const range = sheet.getRangeByIndexes(i + 1, 0, 1, columnCount);
      range.format.fill = i % 2 === 0 ? '#FFFFFF' : COLORS.light;
      // Compact job lists show only a preview of long reasons. The complete
      // text remains in each cell for the formula bar or manual row expansion.
      if (SETTINGS[data.name].rowHeight) range.format.rowHeight = SETTINGS[data.name].rowHeight;
      else {
        const lines = Math.max(...data.rows[i].map((value, column) => wrapLines(value, widths[column] || 24)));
        range.format.rowHeight = Math.min(409, Math.max(32, lines * 15 + 10));
      }
    }
  }
  const header = sheet.getRangeByIndexes(0, 0, 1, columnCount);
  header.format = {
    fill: COLORS.header,
    font: {name: DEFAULT_FONT, size: 11, bold: true, color: '#FFFFFF'},
    horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true,
    rowHeight: 34,
    borders: {insideVertical: {style: 'thin', color: '#FFFFFF'}},
  };
  if (['岗位匹配', '待核实与未评估'].includes(data.name)) {
    data.headers.forEach((label, column) => {
      const v5Tips={'能力匹配度':'高/中须有实际支持；低须有明确的核心能力缺口事实。不确定表示资料不足，不等于能力低。','硬性条件匹配度':'学历、专业、必需资格和到岗等逐项核对。工作年限为经验参考，差距不自动否决；缺资料保持未知。','城市意愿匹配':'仅匹配城市偏好，不判断同城距离或通勤；未指定与明确不限分开，岗位城市未知不等于不符。','薪资参考':SALARY_NOTICE+'仅同等主要判断内辅助排序，未知不扣分。','证据充分性':'说明已有事实及具体缺项，不作为能力评分。已审阅仍可不确定。','匹配层级':'先保留已证实的关键冲突；没有明确冲突但关键资料缺失时显示信息待确认。薪资不单独否决。'};
      const tip = data.modelVersion===5?v5Tips[label]||HEADER_TIPS[label]:HEADER_TIPS[label];
      if (!tip) return;
      const address = String.fromCharCode(65 + column) + '1';
      workbook.notes.add({
        id: `${sheet.name}:${address}`,
        target: {cell: {sheetName: sheet.name, sheetId: sheet.sheetId, address}},
        authorId: noteAuthorId,
        createdAt: '',
        body: {plainText: tip},
      });
    });
  }
  for (const {row, column, url, label} of data.links || []) {
    if (!/^https?:\/\//i.test(url)) throw new Error('不支持的 JD 链接：' + url);
    const cell = sheet.getCell(row - 1, column - 1);
    // Use ordinary text for calculation/rendering; native hyperlinks are added
    // to the exported OOXML below because HYPERLINK is not implemented here.
    cell.values = [[literal(label || url)]];
    cell.format.font = {name: DEFAULT_FONT, size: 11, color: '#1762A2', underline: 'single'};
  }
  if (['岗位匹配', '待核实与未评估'].includes(data.name) && data.rows.length) {
    const recommendation = sheet.getRange(`E2:E${rowCount}`);
    for (const [text, fill, color] of [['可以投递', '#E4F1E9', '#236444'], ['投递前准备', '#EDF2F8', '#345A80'], ['补资料后判断', '#FFF4DC', '#805F1B'], ['暂不建议投递', '#F0F1F3', '#697384'], ['待评估', '#FFF4DC', '#805F1B']]) {
      recommendation.conditionalFormats.add('containsText', {text, format: {fill, font: {color, bold: true}}});
    }
    const hardCondition = sheet.getRange(`J2:J${rowCount}`);
    for (const [text, fill, color] of [['不匹配', '#FCE8E6', '#A33A2B'], ['待核实', '#FFF4DC', '#805F1B'], ['待评估', '#FFF4DC', '#805F1B']]) {
      hardCondition.conditionalFormats.add('containsText', {text, format: {fill, font: {color, bold: true}}});
    }
  }
  if (data.name === '来源覆盖' && data.rows.length) {
    sheet.getRange(`C2:E${rowCount}`).setNumberFormat('#,##0');
    sheet.getRange(`C2:E${rowCount}`).format.horizontalAlignment = 'right';
  }
  data.rows.forEach((row, i) => row.forEach((value, column) => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(value)) sheet.getCell(i + 1, column).setNumberFormat(data.name === '公司简介' ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm');
  }));
  if (data.name === '说明') {
    data.rows.forEach((row, i) => {
      if (typeof row[1] === 'number') sheet.getCell(i + 1, 1).setNumberFormat('#,##0');
    });
  }
}

// Supplement the library's native hyperlink and exact numeric-text export gaps.
// Normal worksheet content and formatting is authored by Artifact Tool.
async function finalizeExcelXml(file, sheets) {
  const {default: JSZip} = await loadRuntimePackage('jszip');
  const xmlModule = await loadRuntimePackage('xml-js');
  const {xml2js, js2xml} = xmlModule.default || xmlModule;
  const saxModule = await loadRuntimePackage('sax');
  const sax = saxModule.default || saxModule;
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const children = (node, name) => (node.elements || []).filter(item => item.type === 'element' && item.name.split(':').pop() === name);
  const parse = text => xml2js(text, {compact: false});
  const escapeAttribute = value => String(value).replace(/[&<>"\t\n\r]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;'}[char]));
  // xml-js escapes quotes before attributeValueFn but leaves & and < raw.
  // Read the original attribute, so each legal character is escaped exactly
  // once, including entity-looking text and attributes parsed from old rels.
  const serialize = document => js2xml(document, {compact: false, attributeValueFn: (_value, name, _elementName, element) => escapeAttribute(element.attributes[name])});
  const root = doc => doc.elements.find(item => item.type === 'element');
  const workbook = root(parse(await zip.file('xl/workbook.xml').async('string')));
  const workbookRels = root(parse(await zip.file('xl/_rels/workbook.xml.rels').async('string')));
  const relations = new Map(children(workbookRels, 'Relationship').map(item => [item.attributes.Id, item.attributes.Target]));
  const sheetEntries = children(children(workbook, 'sheets')[0], 'sheet');
  for (const data of sheets) {
    const numericTextCells = new Map();
    data.rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
      if (isNumericText(value)) numericTextCells.set(String.fromCharCode(65 + columnIndex) + (rowIndex + 2), value);
    }));
    if (!data.links?.length && !numericTextCells.size) continue;
    const entry = sheetEntries.find(item => item.attributes.name === data.name);
    const target = relations.get(entry.attributes['r:id']);
    const sheetPath = target.startsWith('/') ? target.slice(1) : path.posix.normalize('xl/' + target);
    let xml = await zip.file(sheetPath).async('string');
    const prefix = xml.match(/<(\w+:)?worksheet\b/)[1] || '';
    if (numericTextCells.size) {
      // Match only original numeric strings, never strip quotes globally or
      // touch genuine numbers, formulas, or user-authored leading apostrophes.
      // A self-closing blank cell must not consume the next populated cell.
      xml = xml.replace(/<((?:\w+:)?c)\b([^>]*?)(?:\s*\/>|>[\s\S]*?<\/\1>)/g, (cell, name, attributes) => {
        const address = attributes.match(/\br="([^"]+)"/)?.[1];
        if (!numericTextCells.has(address)) return cell;
        const value = numericTextCells.get(address);
        numericTextCells.delete(address);
        const typed = /\bt="[^"]*"/.test(attributes) ? attributes.replace(/\bt="[^"]*"/, 't="str"') : attributes + ' t="str"';
        // Numeric text has no XML metacharacters; keep the exact source bytes.
        return `<${name}${typed}><${prefix}v>${value}</${prefix}v></${name}>`;
      });
      if (numericTextCells.size) throw new Error('Excel 导出缺少数字文本单元格：' + data.name + '!' + [...numericTextCells.keys()].join('、'));
    }
    if (!data.links?.length) { zip.file(sheetPath, xml); continue; }
    const relPath = path.posix.join(path.posix.dirname(sheetPath), '_rels', path.posix.basename(sheetPath) + '.rels');
    const existingRels = zip.file(relPath);
    const relDoc = existingRels ? parse(await existingRels.async('string')) : {elements: [{type: 'element', name: 'Relationships', attributes: {xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships'}, elements: []}]};
    const relRoot = root(relDoc);
    relRoot.elements ||= [];
    const ids = new Set(children(relRoot, 'Relationship').map(item => item.attributes.Id));
    let counter = 1;
    const links = data.links.map(link => {
      const attributes = {ref: String.fromCharCode(64 + link.column) + link.row, display: link.label || link.url};
      if (link.url.startsWith('#')) attributes.location = link.url.slice(1);
      else {
        while (ids.has('rIdCampus' + counter)) counter++;
        const id = 'rIdCampus' + counter++; ids.add(id); attributes['r:id'] = id;
        relRoot.elements.push({type: 'element', name: 'Relationship', attributes: {Id: id, Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', Target: link.url, TargetMode: 'External'}});
      }
      return {type: 'element', name: prefix + 'hyperlink', attributes};
    });
    xml = xml.replace(/<(?:\w+:)?hyperlinks\b[\s\S]*?<\/(?:\w+:)?hyperlinks>/g, '');
    const open = xml.match(/<(?:\w+:)?worksheet\b[^>]*>/)[0];
    if (!/xmlns:r=/.test(open)) xml = xml.replace(open, open.slice(0, -1) + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
    const fragment = serialize({elements: [{type: 'element', name: prefix + 'hyperlinks', elements: links}]});
    // Insert at the worksheet schema position, before page/drawing/table parts.
    const after = /<(?:\w+:)?(?:printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/;
    const offset = xml.search(after);
    xml = offset >= 0 ? xml.slice(0, offset) + fragment + xml.slice(offset) : xml.replace(/<\/(?:\w+:)?worksheet>/, closing => fragment + closing);
    zip.file(sheetPath, xml);
    zip.file(relPath, serialize(relDoc));
  }
  // Validate every XML part without building a worksheet-sized object tree.
  // A bad URL/label must fail before the completed report is replaced.
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/\.(?:xml|rels)$/i.test(name)) continue;
    try { sax.parser(true, {xmlns: true}).write(await entry.async('string')).close(); }
    catch (error) { throw new Error('Excel XML 无效：' + name + '；' + error.message); }
  }
  await fs.writeFile(file, await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6}}));
}

export async function writeExcelReport(file, sheets, {previewDir, temporaryDir} = {}) {
  const {Workbook, SpreadsheetFile} = await loadArtifactTool();
  const workbook = Workbook.create();
  for (const data of sheets) workbook.worksheets.add(data.name);
  const noteAuthorId = workbook.comments.setSelf({displayName: SEARCH_MODE.label+'岗位匹配'}).id;
  sheets.forEach((data, index) => formatTable(workbook, workbook.worksheets.getItem(data.name), data, index, noteAuthorId));
  workbook.recalculate();
  const columns=sheets.find(s=>s.name==='岗位匹配')?.headers.length||12;
  const inspection = await workbook.inspect({kind: 'table', range: `岗位匹配!A1:${columns===15?'O':'L'}3`, tableMaxRows: 3, tableMaxCols: columns, tableMaxCellChars: 100, maxChars: 2500});
  const errors = await workbook.inspect({kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: {useRegex: true, maxResults: 10}, maxChars: 2500, summary: 'Excel 公式错误检查'});
  const formulaErrors = errors.ndjson.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.kind === 'match' && item.formula && /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)$/.test(item.value));
  if (formulaErrors.length) throw new Error('Excel 公式错误：' + formulaErrors.map(item => `${item.sheet}!${item.address} ${item.value}`).join('；'));
  if (previewDir) {
    // Layout previews precede the OOXML fixes; validate exact identifiers and
    // clickable links from the finalized XLSX rather than these preview images.
    await fs.mkdir(previewDir, {recursive: true});
    await fs.writeFile(path.join(previewDir, 'inspection.json'), JSON.stringify({inspection: inspection.ndjson, errors: errors.ndjson}, null, 2));
    for (const data of sheets) {
      const finalColumn = String.fromCharCode(64 + data.headers.length);
      const finalRow = data.name === '公司简介' ? Math.min(7, data.rows.length + 1) : Math.min(3, data.rows.length + 1);
      const preview = await workbook.render({sheetName: data.name, range: `A1:${finalColumn}${finalRow}`, scale: 1, format: 'png'});
      await fs.writeFile(path.join(previewDir, data.name + '.png'), new Uint8Array(await preview.arrayBuffer()));
    }
  }
  await fs.mkdir(path.dirname(file), {recursive: true});
  const output = await SpreadsheetFile.exportXlsx(workbook);
  // An atomic rename keeps the previous completed report if export fails.
  temporaryDir ||= path.resolve(path.dirname(file), '../../tmp/excel-export');
  await fs.mkdir(temporaryDir, {recursive: true});
  const temporary = path.join(temporaryDir, path.basename(file) + '.tmp.xlsx');
  await output.save(temporary);
  await finalizeExcelXml(temporary, sheets);
  await fs.rename(temporary, file);
  return {file, inspection: inspection.ndjson, errors: errors.ndjson};
}
