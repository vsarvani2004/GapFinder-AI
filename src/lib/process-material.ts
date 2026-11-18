import { chunkText, embedMany, groq, userDb } from "@/lib/server";
import { extractPdfText } from "@/lib/pdf";

export async function processMaterial(input: {
  userId: string;
  material: { id: string; storage_path: string };
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  storageAlreadyExists?: boolean;
}) {
  const { userId, material, fileName, mimeType, bytes, storageAlreadyExists = false } = input;
  let stage = "clearing partial rows from an earlier attempt";
  try {
    // A retry reuses its existing material ID. Clear any remnants before generating
    // new rows so unique chunk indexes/topic names cannot turn a retry into duplicates.
    await userDb("document_chunks", "DELETE", `user_id=eq.${userId}&material_id=eq.${material.id}`);
    await userDb("topics", "DELETE", `user_id=eq.${userId}&material_id=eq.${material.id}`);

    if (!storageAlreadyExists) {
      stage = "uploading the file to Supabase Storage";
      const storageUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!storageUrl || !service) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
      const bucket = process.env.SUPABASE_STORAGE_BUCKET || "study-materials";
      let storageResponse: Response;
      try {
        storageResponse = await fetch(`${storageUrl}/storage/v1/object/${bucket}/${material.storage_path.split("/").map(encodeURIComponent).join("/")}`, {
          method: "POST",
          headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": mimeType, "x-upsert": "true" },
          body: bytes.slice().buffer as ArrayBuffer,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error("Supabase Storage upload timed out after 60 seconds.");
        throw new Error("Could not reach Supabase Storage. Check the project URL and network connection.");
      }
      if (!storageResponse.ok) {
        const detail = (await storageResponse.text()).slice(0, 220);
        throw new Error(`Supabase Storage returned HTTP ${storageResponse.status}${storageResponse.status === 401 || storageResponse.status === 403 ? "; check SUPABASE_SERVICE_ROLE_KEY and bucket permissions" : ""}${detail ? `: ${detail}` : "."}`);
      }
    }

    let text = "";
    stage = "extracting text";
    if (/\.txt$/i.test(fileName)) text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    else text = await extractPdfText(bytes);
    if (text.trim().length < 40) throw new Error("This document contains too little readable text to process.");

    const chunks = chunkText(text);
    if (!chunks.length) throw new Error("Text extraction produced no usable passages.");
    if (chunks.length > 64) throw new Error(`This document produced ${chunks.length} chunks, above the 64-chunk processing limit. Split it into smaller files and retry.`);

    stage = "extracting topics with Groq";
    const topicResult = await groq("Extract a concise topic hierarchy from supplied study notes. Return JSON {topics:[{name,section}]} only. Never infer subjects absent from notes.", text.slice(0, 12_000));
    const topics = Array.isArray(topicResult.topics)
      ? topicResult.topics.filter((topic: { name?: unknown }) => typeof topic.name === "string" && topic.name.trim()).slice(0, 40)
      : [];
    if (!topics.length) throw new Error("Groq returned no topics. Check GROQ_MODEL/GROQ_API_KEY or try clearer notes.");

    stage = "saving extracted topics";
    await userDb("topics", "POST", "", topics.map((topic: { name: string; section?: string }) => ({
      user_id: userId,
      material_id: material.id,
      name: topic.name.trim().slice(0, 120),
      section: String(topic.section || "").slice(0, 120),
    })));

    stage = "generating embeddings";
    const batches = Array.from({ length: Math.ceil(chunks.length / 32) }, (_, index) => ({
      offset: index * 32,
      texts: chunks.slice(index * 32, (index + 1) * 32),
    }));
    const embeddings = await Promise.all(batches.map((batch) => embedMany(batch.texts)));
    const rows = batches.flatMap((batch, batchIndex) => batch.texts.map((content, index) => ({
      user_id: userId,
      material_id: material.id,
      content,
      chunk_index: batch.offset + index,
      section: null,
      embedding: embeddings[batchIndex][index],
    })));

    stage = "saving chunks and embeddings to Supabase";
    await userDb("document_chunks", "POST", "", rows);

    stage = "marking material ready";
    try { await userDb("study_materials", "PATCH", `user_id=eq.${userId}&id=eq.${material.id}`, { status: "ready", processing_error: null }); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("processing_error")) throw error; await userDb("study_materials", "PATCH", `user_id=eq.${userId}&id=eq.${material.id}`, { status: "ready" }); }
    return { id: material.id, status: "ready", topics: topics.length, chunks: chunks.length };
  } catch (error) {
    let reason = error instanceof Error ? error.message : "Unexpected processing error.";
    for (const secret of [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.GROQ_API_KEY, process.env.EMBEDDING_API_KEY]) {
      if (secret) reason = reason.replaceAll(secret, "[redacted]");
    }
    reason = reason.replace(/(?:Bearer\s+)?(?:gsk_|sb_(?:secret|publishable|service_role)_|sk-[A-Za-z0-9_-]+)[^\s]*/gi, "[redacted]").slice(0, 500);
    await userDb("document_chunks", "DELETE", `user_id=eq.${userId}&material_id=eq.${material.id}`).catch(() => undefined);
    await userDb("topics", "DELETE", `user_id=eq.${userId}&material_id=eq.${material.id}`).catch(() => undefined);
    const failure = { status: "failed", processing_error: `Failed while ${stage}: ${reason}` };
    try {
      await userDb("study_materials", "PATCH", `user_id=eq.${userId}&id=eq.${material.id}`, failure);
    } catch {
      await userDb("study_materials", "PATCH", `user_id=eq.${userId}&id=eq.${material.id}`, { status: "failed" }).catch(() => undefined);
    }
    throw new Error(`${fileName}: failed while ${stage}. ${reason}`);
  }
}
