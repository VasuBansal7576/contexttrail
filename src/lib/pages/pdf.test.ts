import { expect, it } from 'vitest';
import { pdfSourceHtml } from './pdf';
import { extractPage } from './extract';
function fixturePdf() {
  const text = 'BT /F1 12 Tf 20 120 Td (Independent paper with retained evidence about payment adoption.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object,index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = output.length;
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10,'0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(output);
}
it('reads selectable PDF text in the actual isolated parser without manufacturing publication metadata', async () => {
  const html = await pdfSourceHtml(fixturePdf(), AbortSignal.timeout(5000));
  expect(html).toContain('Independent paper with retained evidence about payment adoption.');
  const page = extractPage(html,'https://source.example.org/study.pdf');
  expect(page.paragraphs.join(' ')).toContain('payment adoption');
  expect(page.jsonLdDates).toEqual([]); expect(page.metaDates).toEqual([]);
});
it('rejects an invalid signature and cancelled work before parsing', async () => {
  await expect(pdfSourceHtml(new TextEncoder().encode('not a PDF'), new AbortController().signal)).rejects.toThrow('signature');
  const controller = new AbortController(); controller.abort();
  await expect(pdfSourceHtml(fixturePdf(),controller.signal)).rejects.toThrow();
});
