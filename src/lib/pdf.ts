import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Extract real page text through Mozilla PDF.js, including compressed streams. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  if (data.length < 8) throw new Error("The PDF file is empty or truncated.");
  // Keep PDF.js external to Next's server chunks. Its Node fake-worker fallback
  // dynamically imports workerSrc; resolve that worker from the installed package
  // instead of PDF.js's relative ./pdf.worker.mjs default (relative to .next chunks).
  const require = createRequire(`${process.cwd()}/package.json`);
  const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const workerUrl = pathToFileURL(workerPath).href;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const loading = pdfjs.getDocument({ data, useSystemFonts: true });
  let document: Awaited<typeof loading.promise> | undefined;
  try {
    try { document = await loading.promise; }
    catch (error) {
      const message = error instanceof Error ? error.message : "Invalid PDF data.";
      if (/password|encrypted/i.test(message) || (error && typeof error === "object" && "name" in error && error.name === "PasswordException")) {
        throw new Error("This PDF is encrypted or password-protected. Remove its password protection and upload it again.");
      }
      throw new Error(`PDF.js could not parse this PDF: ${message.slice(0, 220)}`);
    }
    if (!document.numPages) throw new Error("This PDF has no pages.");
    const pageText: string[] = [];
    let hasPageImages = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item && typeof item.str === "string" ? item.str : "").join(" ");
      pageText.push(text);
      const operators = await page.getOperatorList();
      const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageXObjectRepeat]);
      if (operators.fnArray.some((op) => imageOps.has(op))) hasPageImages = true;
      page.cleanup();
    }
    const extracted = pageText.join("\n").replace(/[\t\u00a0 ]+/g, " ").replace(/ *\n */g, "\n").trim();
    if (extracted.length < 40) {
      if (hasPageImages) throw new Error("This PDF contains page images but no selectable text. It appears to be scanned; OCR is required for this file.");
      throw new Error("This PDF has no extractable text. Its pages may be blank or its lettering may be converted to vector outlines.");
    }
    return extracted;
  } finally {
    await loading.destroy();
  }
}
