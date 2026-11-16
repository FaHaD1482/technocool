import ExcelJS from 'exceljs';

export const COSTING_SHEET = 'Costing (internal)';
const FORBIDDEN = /costing|internal|cost price/i;

/** Guard for anything leaving the company: no costing / internal sheet. */
export function assertClientSafe(wb: ExcelJS.Workbook) {
  const bad = wb.worksheets.find((w) => FORBIDDEN.test(w.name));
  if (bad) throw new Error(`Refusing to send: the file contains the internal sheet "${bad.name}".`);
}

/** Same check on a stored file (the worker re-opens every attachment just before sending). */
export async function assertClientSafeFile(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  assertClientSafe(wb);
}
