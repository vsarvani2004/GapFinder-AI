import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { auth, currentUser, groq, retrieve, userDb } from "@/lib/server";
import { processMaterial } from "@/lib/process-material";

const fileMime = (file: File) => file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain");

const fail = (e: unknown, status = 400) => Response.json({ error: e instanceof Error ? e.message : "Request failed." }, { status });
const safe = (v: string) => v.replace(/[\"\\]/g, "");
export async function GET(_req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  try { const { action } = await params;
    if (action === "connection") {
      const url=process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(); const key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
      if(!url||!key)return Response.json({configured:false,reachable:false,message:"Supabase URL or publishable/anon key is missing from the server environment. Restart Next.js after saving .env.local."},{status:503});
      try { const response=await fetch(`${url.replace(/\/$/,"")}/auth/v1/settings`,{headers:{apikey:key},cache:"no-store"}); return Response.json({configured:true,reachable:response.ok,keyAccepted:response.ok?true:undefined,httpStatus:response.status,message:response.ok?"Supabase Auth connection is working.":"Supabase responded but did not accept this key. Check that it belongs to this project."},{status:response.ok?200:502}); }
      catch { return Response.json({configured:true,reachable:false,message:"The Supabase URL could not be reached. Check the URL and network access."},{status:502}); }
    }
    const user = await currentUser(); if (action === "session") return Response.json({ user }); if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
    const uid = user.id;
    if (action === "dashboard") {
      const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
      const staleFilter=`user_id=eq.${uid}&status=eq.processing&created_at=lt.${encodeURIComponent(staleBefore)}`;
      await userDb("study_materials", "PATCH", staleFilter, { status:"failed", processing_error:"Processing took over 10 minutes or the server stopped before finishing. Check your provider configuration and upload again." }).catch(()=>userDb("study_materials","PATCH",staleFilter,{status:"failed"}).catch(()=>undefined));
      let materials;
      try { materials=await userDb("study_materials", "GET", `select=id,name,mime_type,size_bytes,status,processing_error,created_at&user_id=eq.${uid}&order=created_at.desc`); }
      catch(error) { if(!(error instanceof Error)||!error.message.includes("processing_error"))throw error; const legacy=await userDb("study_materials", "GET", `select=id,name,mime_type,size_bytes,status,created_at&user_id=eq.${uid}&order=created_at.desc`); materials=legacy.map((m:Record<string,unknown>)=>({...m,processing_error:null})); }
      const readyIds=materials.filter((m:Record<string,string>)=>m.status==="ready").map((m:Record<string,string>)=>m.id);
      const [topics, attempts, tasks, performance, plans] = await Promise.all([readyIds.length?userDb("topics", "GET", `select=id,name,section,material_id&user_id=eq.${uid}&material_id=in.(${readyIds.join(",")})&order=name.asc`):Promise.resolve([]), userDb("quiz_attempts", "GET", `select=id,score,total_questions,created_at&user_id=eq.${uid}&order=created_at.desc&limit=8`), userDb("revision_tasks", "GET", `select=id,title,topic_id,duration_minutes,completed&user_id=eq.${uid}&order=created_at.desc&limit=10`), userDb("topic_performance", "GET", `select=*&user_id=eq.${uid}`), userDb("revision_plans", "GET", `select=*&user_id=eq.${uid}&order=updated_at.desc&limit=1`)]); return Response.json({ materials, topics, attempts, tasks, performance, plan:plans[0]||null });
    }
    if (action === "materials") return Response.json(await userDb("study_materials", "GET", `select=*&user_id=eq.${uid}&order=created_at.desc`));
    if (action === "topics") { const ready=await userDb("study_materials","GET",`select=id&user_id=eq.${uid}&status=eq.ready`);if(!ready.length)return Response.json([]);return Response.json(await userDb("topics","GET",`select=*&user_id=eq.${uid}&material_id=in.(${ready.map((m:{id:string})=>m.id).join(",")})&order=name.asc`)); }
    if (action === "attempts") return Response.json(await userDb("quiz_attempts", "GET", `select=*,student_answers(*,questions(*,topics(name)))&user_id=eq.${uid}&order=created_at.desc&limit=25`));
    if (action === "tasks") return Response.json(await userDb("revision_tasks", "GET", `select=*,topics(name)&user_id=eq.${uid}&order=created_at.asc`));
    return Response.json({ error: "Unknown action." }, { status: 404 });
  } catch (e) { return fail(e); }
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
 try { const { action } = await params;
  if (action === "auth") { const { email, password, name, mode } = await req.json(); if (typeof email !== "string" || typeof password !== "string" || password.length < 8) throw new Error("Enter a valid email and password of at least 8 characters."); const data = await auth(mode === "signup" ? "signup" : "token?grant_type=password", { email, password, ...(name ? { data: { full_name: name } } : {}) }); if (mode === "signup" && !data.access_token) return Response.json({ message: "Check your email to confirm your account, then sign in." }); (await cookies()).set("gf_session", data.access_token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: data.expires_in || 3600 }); return Response.json({ user: data.user }); }
  const user = await currentUser(); if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 }); const uid = user.id;
  if (action === "logout") { (await cookies()).delete("gf_session"); return Response.json({ ok: true }); }
  if (action === "upload") {
    const form = await req.formData(); const files = form.getAll("files").filter((v): v is File => v instanceof File); if (!files.length) throw new Error("Choose a PDF or TXT file."); if (files.some(f => !/\.pdf$|\.txt$/i.test(f.name) || f.size > 15 * 1024 * 1024)) throw new Error("Only PDF and TXT files under 15 MB are accepted.");
    const results = [];
    for (const file of files) {
      const storagePath = `${uid}/${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]/g, "_")}`;
      const bytes=new Uint8Array(await file.arrayBuffer());
      const [material] = await userDb("study_materials", "POST", "", { user_id: uid, name: file.name, mime_type: fileMime(file), size_bytes: file.size, storage_path: storagePath, status: "processing" });
      results.push(await processMaterial({userId:uid,material,fileName:file.name,mimeType:fileMime(file),bytes}));
    }
    return Response.json({ materials: results });
  }
  if (action === "retry-upload") {
    let file: File | null = null;
    let materialId = "";
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const form=await req.formData();
      const candidate=form.get("file");
      file=candidate instanceof File ? candidate : null;
      materialId=String(form.get("materialId")||"");
    } else {
      const body=await req.json();
      materialId=typeof body.materialId === "string" ? body.materialId : "";
    }
    if (!materialId) throw new Error("Retry request is missing its material ID.");
    if (file && (!/\.pdf$|\.txt$/i.test(file.name)||file.size>15*1024*1024)) throw new Error("Only PDF and TXT files under 15 MB are accepted.");
    const [material]=await userDb("study_materials","GET",`select=id,name,mime_type,size_bytes,storage_path,status&user_id=eq.${uid}&id=eq.${safe(materialId)}`);
    if(!material||material.status!=="failed")throw new Error("That failed material was not found in your account.");
    const storageUrl=process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/,"");
    const service=process.env.SUPABASE_SERVICE_ROLE_KEY;
    if(!storageUrl||!service)throw new Error("Supabase Storage is not configured on the server.");
    const bucket=process.env.SUPABASE_STORAGE_BUCKET||"study-materials";
    let bytes: Uint8Array;
    let storageAlreadyExists=true;
    if (file) {
      // The user has selected a replacement only after a missing-object response.
      bytes=new Uint8Array(await file.arrayBuffer());
      storageAlreadyExists=false;
    } else {
      let stored: Response;
      try {
        stored=await fetch(`${storageUrl}/storage/v1/object/${bucket}/${String(material.storage_path).split("/").map(encodeURIComponent).join("/")}`,{
          headers:{apikey:service,Authorization:`Bearer ${service}`},
          cache:"no-store",
          signal:AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if(error instanceof Error&&(error.name==="TimeoutError"||error.name==="AbortError"))throw new Error("Checking the original file in Supabase Storage timed out. Please retry.");
        throw new Error("Could not reach Supabase Storage while checking the original file.");
      }
      if (!stored.ok) {
        const detail=(await stored.text()).slice(0,240);
        if(stored.status===404&&!/bucket.*(not found|does not exist)/i.test(detail)) return Response.json({needsFile:true,message:"The original file is missing from Supabase Storage. Choose the original PDF or TXT file to re-upload and retry this same material."});
        throw new Error(`Could not retrieve the original file from Supabase Storage (HTTP ${stored.status})${stored.status===401||stored.status===403?"; check the server Storage credentials and bucket permissions":""}${detail?`: ${detail}`:"."}`);
      }
      bytes=new Uint8Array(await stored.arrayBuffer());
    }
    const fileName=file?.name||material.name;
    const mimeType=file?fileMime(file):(material.mime_type||(/\.pdf$/i.test(material.name)?"application/pdf":"text/plain"));
    const retryUpdate={status:"processing",processing_error:null,...(file?{name:file.name,mime_type:mimeType,size_bytes:file.size}:{}),created_at:new Date().toISOString()};
    try{await userDb("study_materials","PATCH",`user_id=eq.${uid}&id=eq.${material.id}`,retryUpdate);}
    catch(error){if(!(error instanceof Error)||!error.message.includes("processing_error"))throw error;const fallback={status:"processing",created_at:retryUpdate.created_at,...(file?{name:file.name,mime_type:mimeType,size_bytes:file.size}:{})};await userDb("study_materials","PATCH",`user_id=eq.${uid}&id=eq.${material.id}`,fallback);}
    const result=await processMaterial({userId:uid,material,fileName,mimeType,bytes,storageAlreadyExists});
    return Response.json({material:result});
  }
  if (action === "quiz") {
    const { topicId, count = 5, difficulty = "mixed" } = await req.json(); const ready=await userDb("study_materials","GET",`select=id&user_id=eq.${uid}&status=eq.ready`); if(!ready.length)throw new Error("Upload study materials and process topics before generating a quiz."); const topics = await userDb("topics", "GET", `select=id,name,section&user_id=eq.${uid}&material_id=in.(${ready.map((m:{id:string})=>m.id).join(",")})${topicId?`&id=eq.${safe(String(topicId))}`:""}`); if (!topics.length) throw new Error("Upload study materials and process topics before generating a quiz.");
    const context = await retrieve(topics.map((t: {name:string})=>t.name).join(", "), uid, 8); if (!context.length) throw new Error("No sufficiently relevant source passages were found. Upload more material before generating questions.");
    const sourceLabels = context.map((c: {source_name?:string;section?:string}, i:number) => `[S${i+1}] ${c.source_name || "Study notes"}${c.section ? `, ${c.section}` : ""}`);
    const generated = await groq("Create source-grounded diagnostic questions only from provided passages. Return JSON {questions:[{topic,kind,prompt,options,answer,explanation,source}]}. kind is mcq, true_false, or short. MCQ options must be four strings and answer must exactly equal one options string. true_false options are [True,False] and answer must exactly equal True or False. source must be one provided source ID (S1, S2, etc). No outside facts.", `Difficulty: ${difficulty}. Create ${Math.min(10, Math.max(1, Number(count)))} varied questions across these topics: ${topics.map((t: {name:string})=>t.name).join(", ")}. Sources:\n${context.map((c: {content:string},i:number)=>`[S${i+1}] ${c.content}`).join("\n\n")}`);
    const valid = (generated.questions || []).filter((q: {prompt?:string;answer?:string;kind?:string;options?:unknown})=>{
      if(!q.prompt||!q.answer)return false;
      if(q.kind==="mcq")return Array.isArray(q.options)&&q.options.length>=2&&q.options.some((o:unknown)=>String(o).trim().toLowerCase()===String(q.answer).trim().toLowerCase());
      if(q.kind==="true_false")return ["true","false"].includes(String(q.answer).trim().toLowerCase());
      return true;
    }).slice(0, 10); if (!valid.length) throw new Error("Could not generate valid questions from the retrieved passages. Try again or upload clearer study material.");
    const [attempt] = await userDb("quiz_attempts", "POST", "", { user_id: uid, total_questions: valid.length, status: "in_progress" });
    const savedQuestions = [];
    for (const q of valid) { const topic = topics.find((t: {name:string})=>t.name.toLowerCase() === String(q.topic).toLowerCase()) || topics[0]; const sourceIndex=Number(String(q.source||"").replace(/^S/i,""))-1; const source=sourceLabels[sourceIndex] || sourceLabels[0]; const [saved] = await userDb("questions", "POST", "", { attempt_id: attempt.id, user_id: uid, topic_id: topic.id, kind: ["mcq","true_false","short"].includes(q.kind) ? q.kind : "short", prompt: String(q.prompt), options: Array.isArray(q.options) ? q.options : [], correct_answer: String(q.answer), explanation: String(q.explanation || "Review the cited source passage."), source }); savedQuestions.push({ ...saved, topic:topic.name }); }
    return Response.json({ attemptId: attempt.id, questions: savedQuestions.map((q: {id:string;topic:string;kind:string;prompt:string;options:string[];source:string})=>({ id:q.id, topic:q.topic, kind:q.kind, prompt:q.prompt, options:q.options, source:q.source })) });
  }
  if (action === "submit") {
    const { attemptId, answers } = await req.json(); const questions = await userDb("questions", "GET", `select=*&user_id=eq.${uid}&attempt_id=eq.${safe(String(attemptId))}`); if (!questions.length) throw new Error("Quiz not found."); let points = 0;
    const evaluated=[];
    for (const q of questions) { const answer = String(answers?.[q.id] ?? ""); let result: {correct:boolean;feedback:string;score:number};
      if (q.kind === "mcq" || q.kind === "true_false") { const correct = answer.trim().toLowerCase() === q.correct_answer.trim().toLowerCase(); result = { correct, score: correct ? 1 : 0, feedback: correct ? "Correct." : `The answer is ${q.correct_answer}. ${q.explanation}` }; }
      else { const grade = await groq("Grade the student's short answer against the supplied reference answer. Return JSON {score:0|0.5|1,feedback:string}. Award partial credit only for substantially correct key ideas. Be strict and concise.", `Question: ${q.prompt}\nReference answer: ${q.correct_answer}\nExplanation: ${q.explanation}\nStudent answer: ${answer || "[blank]"}`); const score=Math.max(0,Math.min(1,Number(grade.score)||0)); result={score,correct:score>=0.75,feedback:String(grade.feedback||q.explanation)}; }
      points += result.score; await userDb("student_answers", "POST", "", { user_id: uid, attempt_id: attemptId, question_id: q.id, answer_text: answer, score: result.score, feedback: result.feedback }); evaluated.push({ question:q.prompt, answer, correctAnswer:q.correct_answer, explanation:q.explanation, source:q.source, ...result, topicId:q.topic_id });
    }
    const score=Math.round(points/questions.length*100); await userDb("quiz_attempts", "PATCH", `id=eq.${safe(String(attemptId))}`, { score, status:"completed", completed_at:new Date().toISOString() });
    const byTopic=new Map<string,{right:number;total:number}>(); for (const e of evaluated) { const t=byTopic.get(e.topicId)||{right:0,total:0};t.total++; t.right+=e.score;byTopic.set(e.topicId,t); }
    for (const [topicId,p] of byTopic) { const percent=Math.round(p.right/p.total*100); const level=percent<50?"weak":percent<80?"medium":"strong"; const [prior]=await userDb("topic_performance","GET",`select=id&user_id=eq.${uid}&topic_id=eq.${topicId}`); const payload={user_id:uid,topic_id:topicId,score:percent,classification:level,correct_answers:Math.round(p.right),incorrect_answers:p.total-Math.round(p.right),reason:`${Math.round(p.right)} of ${p.total} answers earned full credit.`,updated_at:new Date().toISOString()}; if(prior) await userDb("topic_performance","PATCH",`id=eq.${prior.id}`,payload); else await userDb("topic_performance","POST","",payload); await userDb("progress_history","POST","",{user_id:uid,topic_id:topicId,score:percent}); }
    const [savedPlan]=await userDb("revision_plans","GET",`select=id,available_minutes&user_id=eq.${uid}&order=updated_at.desc&limit=1`); const plan=savedPlan || (await userDb("revision_plans","POST","",{user_id:uid,available_minutes:60}))[0];
    const priority=[...byTopic.entries()].sort((a,b)=>a[1].right/a[1].total-b[1].right/b[1].total); const perTask=Math.max(10,Math.floor(Number(plan.available_minutes||60)/Math.max(priority.length,1)));
    for(const [topicId,p] of priority){const [topic]=await userDb("topics","GET",`select=name&user_id=eq.${uid}&id=eq.${topicId}`);const [openTask]=await userDb("revision_tasks","GET",`select=id&user_id=eq.${uid}&topic_id=eq.${topicId}&completed=eq.false&limit=1`);const task={user_id:uid,plan_id:plan.id,topic_id:topicId,title:`${Math.round(p.right/p.total*100)<50?"Focus on":"Review"} ${topic?.name||"this topic"} and retry practice`,duration_minutes:perTask,completed:false};if(openTask)await userDb("revision_tasks","PATCH",`id=eq.${openTask.id}&user_id=eq.${uid}`,task);else await userDb("revision_tasks","POST","",task);}
    return Response.json({score,total:questions.length,results:evaluated});
  }
  if (action === "chat") { const { question }=await req.json(); if(typeof question!=="string"||question.length<3||question.length>1200)throw new Error("Ask a question between 3 and 1,200 characters."); const matches=await retrieve(question,uid,5); if(!matches.length)return Response.json({answer:"I couldn’t find enough relevant information in your uploaded materials to answer that reliably. Upload notes covering this topic and ask again.",citations:[]}); const sources=matches.map((m: {content:string;source_name?:string;section?:string},i:number)=>({id:`S${i+1}`,label:`${m.source_name || "Study notes"}${m.section ? `, ${m.section}` : ""}`,content:m.content})); const result=await groq("Answer simply using only retrieved study material. If it doesn't contain the answer, say so. Return JSON {answer:string,citations:[string]}; citations must contain only supplied source IDs.",`Question: ${question}\nSources:\n${sources.map((s)=>`[${s.id}] ${s.content}`).join("\n\n")}`); const citations=Array.isArray(result.citations)?result.citations.filter((id:string)=>sources.some(s=>s.id===id)).map((id:string)=>sources.find(s=>s.id===id)!.label):[]; return Response.json({answer:result.answer,citations:[...new Set(citations)]}); }
  if (action === "task") { const {id,completed}=await req.json(); await userDb("revision_tasks","PATCH",`id=eq.${safe(String(id))}&user_id=eq.${uid}`,{completed:Boolean(completed)});return Response.json({ok:true}); }
  if (action === "plan") { const {availableMinutes}=await req.json();const mins=Math.max(15,Math.min(480,Number(availableMinutes)||60));const [existing]=await userDb("revision_plans","GET",`select=id&user_id=eq.${uid}&order=updated_at.desc&limit=1`);if(existing)await userDb("revision_plans","PATCH",`id=eq.${existing.id}&user_id=eq.${uid}`,{available_minutes:mins,updated_at:new Date().toISOString()});else await userDb("revision_plans","POST","",{user_id:uid,available_minutes:mins});return Response.json({availableMinutes:mins}); }
  if (action === "delete-material") { const {id}=await req.json(); const [m]=await userDb("study_materials","GET",`select=id,storage_path&user_id=eq.${uid}&id=eq.${safe(String(id))}`); if(!m)throw new Error("Material not found.");const storageUrl=process.env.NEXT_PUBLIC_SUPABASE_URL;const service=process.env.SUPABASE_SERVICE_ROLE_KEY;const bucket=process.env.SUPABASE_STORAGE_BUCKET||"study-materials"; await fetch(`${storageUrl}/storage/v1/object/${bucket}/${m.storage_path}`,{method:"DELETE",headers:{apikey:service!,Authorization:`Bearer ${service}`}}); await userDb("study_materials","DELETE",`id=eq.${m.id}&user_id=eq.${uid}`);return Response.json({ok:true}); }
  return Response.json({error:"Unknown action."},{status:404});
 } catch(e) { return fail(e); }
}
