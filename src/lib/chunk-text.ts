export function chunkText(text: string, size = 1100, overlap = 150) {
  const clean = text.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];
  for (let start = 0; start < clean.length; start += size - overlap) {
    const part = clean.slice(start, start + size).trim();
    if (part.length > 80) chunks.push(part);
  }
  return chunks;
}
