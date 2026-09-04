const ExcelJS = require('exceljs');

const COLORS = {
  ink: '173432',
  forest: '103F3B',
  forestLight: 'E7F0ED',
  coral: 'E66B4C',
  gold: 'D4A63E',
  paper: 'F7F4ED',
  line: 'D9D5CB',
  white: 'FFFFFF',
  muted: '687C78',
};

function normalizedHeader(header) {
  return String(header || '').toLowerCase().replace(/[\s_\-\/（）()]/g, '');
}

function cellKind(header) {
  const key = normalizedHeader(header);
  if (/进度|完成率|百分比/.test(key)) return 'percentage';
  if (/记录时间|填报时间|更新时间|进展时间/.test(key)) return 'datetime';
  if (/日期|截止|计划完成|完成期限|开始时间|启动时间|实际完成/.test(key)) return 'date';
  if (/任务编号|任务id|序号/.test(key)) return 'integer';
  return 'text';
}

function typedValue(header, value) {
  if (value == null || value === '') return null;
  const kind = cellKind(header);
  if (kind === 'percentage') {
    const number = typeof value === 'number'
      ? value
      : Number(String(value).replace('%', '').trim());
    return Number.isFinite(number) ? (number > 1 ? number / 100 : number) : String(value);
  }
  if (kind === 'integer') {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : String(value);
  }
  if (kind === 'date' || kind === 'datetime') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function calculateWidth(header, rows) {
  const contentWidth = rows.reduce((width, row) => {
    const value = row[header];
    return Math.max(width, String(value ?? '').length);
  }, String(header).length);
  const kind = cellKind(header);
  if (kind === 'date' || kind === 'datetime') return kind === 'datetime' ? 20 : 14;
  if (kind === 'percentage' || kind === 'integer') return Math.max(12, Math.min(contentWidth + 3, 16));
  return Math.max(12, Math.min(Math.ceil(contentWidth * 1.4) + 3, 42));
}

function statusFill(value) {
  if (value === '已完成') return 'E7F0E4';
  if (value === '受阻') return 'FBE7DF';
  if (value === '进行中') return 'E4F1ED';
  return null;
}

async function writeExcelReport({ filePath, title, period, templateName, headers, rows, polished }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '待办工作台';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = `${period.typeLabel}任务明细`;
  workbook.description = polished ? '根据任务事实生成，并由大模型按表头匹配和润色。' : '根据任务事实生成。';

  const worksheet = workbook.addWorksheet('工作明细', {
    properties: { defaultRowHeight: 22 },
    pageSetup: {
      orientation: headers.length > 7 ? 'landscape' : 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });
  worksheet.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];

  worksheet.mergeCells(1, 1, 1, headers.length);
  worksheet.getCell(1, 1).value = title;
  worksheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: COLORS.ink } };
  worksheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' };
  worksheet.getCell(1, 1).border = { bottom: { style: 'medium', color: { argb: COLORS.coral } } };
  worksheet.getRow(1).height = 34;

  worksheet.mergeCells(2, 1, 2, headers.length);
  worksheet.getCell(2, 1).value = `统计周期：${period.startLabel} - ${period.endLabel}    表格模板：${templateName}    生成方式：${polished ? '大模型匹配与润色' : '本地规则匹配'}`;
  worksheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 9, italic: true, color: { argb: COLORS.muted } };
  worksheet.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' };
  worksheet.getRow(2).height = 24;

  const headerRow = worksheet.getRow(4);
  headerRow.values = headers;
  headerRow.height = 30;
  headerRow.eachCell((cell) => {
    cell.font = { name: 'Microsoft YaHei', size: 10, bold: true, color: { argb: COLORS.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.forest } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      right: { style: 'thin', color: { argb: '6B8A85' } },
      bottom: { style: 'medium', color: { argb: COLORS.gold } },
    };
  });

  for (const rowData of rows) {
    const row = worksheet.addRow(headers.map((header) => typedValue(header, rowData[header])));
    row.height = 34;
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      const header = headers[columnNumber - 1];
      const kind = cellKind(header);
      cell.font = { name: 'Microsoft YaHei', size: 9, color: { argb: COLORS.ink } };
      cell.alignment = {
        vertical: 'top',
        horizontal: ['percentage', 'integer'].includes(kind) ? 'right' : 'left',
        wrapText: true,
      };
      cell.border = { bottom: { style: 'thin', color: { argb: COLORS.line } } };
      if (row.number % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paper } };
      if (kind === 'percentage') cell.numFmt = '0%';
      if (kind === 'integer') cell.numFmt = '#,##0';
      if (kind === 'date') cell.numFmt = 'yyyy-mm-dd';
      if (kind === 'datetime') cell.numFmt = 'yyyy-mm-dd hh:mm';
      const statusColor = /状态/.test(header) ? statusFill(String(cell.value || '')) : null;
      if (statusColor) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusColor } };
    });
  }

  headers.forEach((header, index) => {
    worksheet.getColumn(index + 1).width = calculateWidth(header, rows);
  });
  const lastColumn = worksheet.getColumn(headers.length).letter;
  const lastRow = Math.max(4, worksheet.rowCount);
  worksheet.autoFilter = { from: 'A4', to: `${lastColumn}${lastRow}` };
  worksheet.headerFooter.oddFooter = '待办工作台生成 · &D &T · 第 &P / &N 页';
  worksheet.printArea = `A1:${lastColumn}${lastRow}`;

  await workbook.xlsx.writeFile(filePath);
  return { rowCount: rows.length, columnCount: headers.length };
}

module.exports = { writeExcelReport, typedValue, cellKind };
