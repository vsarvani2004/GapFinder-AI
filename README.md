# GapFinder AI

AI-powered learning platform for identifying knowledge gaps and generating personalized quizzes and revision plans using RAG.



GapFinder AI turns a learner's own PDF and text notes into searchable study material, source-grounded diagnostic questions, answer feedback, topic-level performance, and a practical revision checklist.

## Features

- Supabase email/password sign-up and sign-in, using an HTTP-only session cookie.
- Private per-user study-material records and private Supabase Storage uploads.
- UTF-8 TXT extraction and PDF.js page-text extraction from ordinary, compressed, selectable-text PDFs.
- Topic extraction using Groq, semantic chunk embeddings, pgvector storage and cosine-similarity retrieval.
- Grounded MCQ, true/false, and short-answer quiz generation with source labels.
- Objective choice evaluation and LLM-assisted short-answer grading.
- Transparent topic bands: Weak below 50%, Medium 50–79%, Strong 80% and above.
- Revision tasks, progress history, material management, and a citation-aware study assistant.
- Responsive dashboard, topic map, progress charts, and empty/loading/error states.

## Stack and architecture

- Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4.
- API handlers in `src/app/api/[action]/route.ts` use the Web Request/Response APIs.
- `src/lib/server.ts` holds server-only Supabase Auth/REST, embedding, and Groq helpers.
- `src/lib/process-material.ts` runs upload extraction, topic generation, chunking, embeddings, persistence, and status updates.
- `src/lib/pdf.ts` extracts selectable PDF text with the server-side PDF.js legacy build.
- Browser calls go through same-origin handlers. API secrets are never included in client bundles.
- Supabase Postgres is accessed with the signed-in user's JWT for data operations, so database RLS applies. Private Storage uploads/deletes use the server-only service role after validating the authenticated user and ownership.
- `supabase/schema.sql` defines the application schema, RLS, storage bucket, vector index, and similarity-search RPC.

## RAG workflow

1. The authenticated upload route validates PDF/TXT type and a 15 MB limit, records a `processing` material, and writes bytes to the private Storage bucket.
2. TXT is decoded as UTF-8. Mozilla PDF.js extracts text from selectable PDF pages, including compressed streams. Password-protected PDFs get an explicit error; image-only scanned PDFs are identified and need OCR.
3. Groq extracts topic names from the actual document text. Text is normalized and split into overlapping ~1,100-character chunks.
4. Chunks are sent to the configured OpenAI-compatible embedding endpoint in batches of 32, with bounded request timeouts. The app requires 1,536-dimensional vectors, which it stores in `document_chunks.embedding`. A material becomes `ready` only after chunk and embedding rows have been saved.
5. Quiz and chat routes embed their query separately, call `match_document_chunks` with a 0.25 cosine-similarity floor, and only pass returned passages to Groq.
6. If no passage clears that threshold, chat returns an insufficiency response and quiz generation stops. Citation labels come from retrieved material names and section metadata.

Embedding generation is a separate API request from retrieval and language generation. Groq does not provide embeddings through the configured chat endpoint; use a compatible embedding provider and supply its key/model. PDF extraction uses the PDF.js legacy server build and resolves its worker from the installed package. Selectable-text PDFs do not need OCR; scanned image-only PDFs still require OCR.

## Folder structure

```text
src/app/page.tsx                 Main authenticated workspace UI
src/app/layout.tsx               Root layout and metadata
src/app/globals.css              Responsive visual system
src/app/api/[action]/route.ts    Auth, upload, RAG, quiz, grading and data API
src/lib/server.ts                Server-side auth, database, embeddings and Groq
supabase/schema.sql               Tables, indexes, RLS, vector RPC, private bucket
.env.example                     Required configuration names
```

## Setup

### 1. Install and configure

```bash
npm install
Copy-Item .env.example .env.local
```

Get the Supabase URL and anon/publishable key from **Supabase → Project Settings → API**. Get the service-role key from the same page; keep it only in `.env.local` and Vercel server environment variables. Get `GROQ_API_KEY` from the Groq console. Get an embedding key from OpenAI Platform or another provider that accepts the OpenAI embeddings request shape and returns 1,536 dimensions. Set the endpoint and model accordingly.

Use Node.js 22.13 or newer (PDF.js 6 requirement). In PowerShell, use `npm.cmd` if the local script execution policy blocks `npm.ps1`.

The Supabase anon key is public configuration; the service-role key, Groq key and embedding key are secrets. Never prefix secret keys with `NEXT_PUBLIC_`.

### 2. Set up Supabase

1. Create a Supabase project.
2. In **SQL Editor**, run all of `supabase/schema.sql` as the project owner. It enables pgvector, creates tables and RLS policies, and creates the private `study-materials` bucket. For an existing installation, also run `supabase/migrations/20261117_upload_processing_error.sql` to add the persisted upload failure message column.
3. In **Authentication → Providers → Email**, enable email/password. For a quick assignment demo, turn off email confirmation; otherwise users must confirm registration from email before signing in.
4. Configure every variable listed in `.env.example` in `.env.local`. Provider model IDs and the Storage bucket have documented defaults, but keeping them explicit makes local and Vercel configuration consistent.

No shared demo credentials are embedded. Register a new account in the app. Each account sees only its own rows and uploads. Do not use the service-role key in browser code.

### 3. Run locally

```bash
npm.cmd run dev
npm.cmd run lint
npx.cmd tsc --noEmit
npm.cmd run build
```

Open `http://localhost:3000`. Without external keys, the sign-in screen still loads; API calls explain which setup is missing. Full upload, topic mapping, quiz, embedding, grading and assistant flows require the external services above.

## Deployment

### GitHub

Initialize a Git repository if needed and create a private or public GitHub repository, then connect and push it. Verify `.env.local` is ignored (`.gitignore` excludes `.env*`) and never stage it.

```bash
git init
git add .
git commit -m "Build GapFinder AI learning workspace"
git branch -M main
git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin main
```

Do not commit `.env.local` or service keys. Review `git status` and the staged file list before committing. If `.env.local` was ever committed, remove it from history and rotate those credentials.

### Vercel

Import the pushed GitHub repository into Vercel, select the Next.js framework preset, and set every variable from `.env.example` in **Project Settings → Environment Variables** for Production (and Preview if used): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `GROQ_API_KEY`, `GROQ_MODEL`, `EMBEDDING_API_URL`, `EMBEDDING_API_KEY`, and `EMBEDDING_MODEL`. Keep the service-role, Groq, and embedding keys server-only; only the two `NEXT_PUBLIC_` values are public. Redeploy after changing variables. Run the schema once in Supabase before using the app. Set Supabase Auth Site URL and redirect URLs to the deployed domain and verify email confirmation behavior.

## Known limitations

- Image-only scanned pages need OCR, which is not included. Files producing more than 64 chunks must be split into smaller documents.
- Upload processing is synchronous. Failures persist `failed` plus a processing error; stuck processing rows are marked failed after ten minutes. Retry checks the existing Storage object and reuses the same material record; it asks for the original file only when that object is missing.
- Retrieval uses a fixed 0.25 cosine threshold and 1,536-dimensional embeddings. Keep the configured model and SQL vector dimension aligned.
- AI feature behavior depends on live provider keys, model access, Supabase configuration and network availability. No generated demo statistics are presented as real student data.
- Revision duration is a per-task estimate capped by the time selector; tasks are generated from evaluated topic attempts.

## Data and security

Application tables enable RLS and enforce `auth.uid() = user_id`. API data reads/writes use the signed-in user's JWT. The private service-role key is used only for Storage operations after authenticated ownership checks. Auth access tokens are stored in an HTTP-only, SameSite=Lax cookie. Configure HTTPS in production; the cookie is marked Secure in production.
