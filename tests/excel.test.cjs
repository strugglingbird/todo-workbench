const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const { writeExcelReport, typedValue } = require('../src/main/excel-export.cjs');
const { normalizeExcelConfig } = require('../src/main/config-store.cjs');

test('Excel template config removes duplicate and empty headers', () => {
  const config = normalizeExcelConfig({
    activeTemplateId: 'custom',
    templates: [{ id: 'custom', name: '部门周报', headers: ['任务名称', '', '下一步', '任务名称'] }],
  });
  assert.deepEqual(config.templates[0].headers, ['任务名称', '下一步']);
  assert.equal(config.activeTemplateId, 'custom');
});

test('Excel values preserve percentage, integer and date types', () => {
  assert.equal(typedValue('完成进度', '60%'), 0.6);
  assert.equal(typedValue('任务编号', '12'), 12);
  assert.ok(typedValue('截止日期', '2026-09-30') instanceof Date);
});

test('Excel report has custom headers, typed rows and filtering', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-excel-'));
  const filePath = path.join(directory, 'report.xlsx');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const headers = ['任务名称', '完成进度', '本期完成内容', '记录时间'];
  await writeExcelReport({
    filePath,
    title: '2026年9月周报',
    period: { typeLabel: '周报', startLabel: '2026/09/01', endLabel: '2026/09/07' },
    templateName: '测试模板',
    headers,
    rows: [{
      任务名称: '完成 Excel 导出',
      完成进度: 75,
      本期完成内容: '完成自定义表头映射',
      记录时间: '2026-09-04T08:30:00.000Z',
    }],
    polished: true,
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet('工作明细');
  assert.deepEqual(sheet.getRow(4).values.slice(1), headers);
  assert.equal(sheet.getCell('A5').value, '完成 Excel 导出');
  assert.equal(sheet.getCell('B5').value, 0.75);
  assert.equal(sheet.getCell('B5').numFmt, '0%');
  assert.ok(sheet.getCell('D5').value instanceof Date);
  assert.equal(sheet.autoFilter, 'A4:D5');
});
