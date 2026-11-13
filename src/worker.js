const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function safeName(name) {
  return (name || "source.zip").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

async function githubDispatch(env, jobId) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  if (!owner || !repo || owner.startsWith("YOUR_") || !env.GITHUB_TOKEN) {
    throw new Error("GitHub settings are incomplete. Configure GITHUB_OWNER, GITHUB_REPO and GITHUB_TOKEN.");
  }
  const workflow = env.GITHUB_WORKFLOW || "android-build.yml";
  const ref = env.GITHUB_REF || "main";
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "SONTEEN-AUTO-APK-BUILDER"
      },
      body: JSON.stringify({ ref, inputs: { job_id: jobId } })
    }
  );
  if (!response.ok) throw new Error(`GitHub dispatch failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
}

async function handleUpload(request, env) {
  const form = await request.formData();
  const file = form.get("file");
  const uploadType = String(form.get("uploadType") || "project-zip");
  if (!(file instanceof File)) return json({ error: "Missing source file." }, 400);
  const max = Number(env.MAX_UPLOAD_BYTES || 94371840);
  if (file.size < 1 || file.size > max) return json({ error: `File must be between 1 byte and ${Math.floor(max / 1048576)} MiB.` }, 413);
  if (!["project-zip", "project-folder", "src-folder"].includes(uploadType)) {
    return json({ error: "Unsupported upload type." }, 400);
  }
  const jobId = id();
  const sourceKey = `sources/${jobId}/${safeName(file.name)}`;
  await env.BUILDS.put(sourceKey, file.stream(), {
    httpMetadata: { contentType: "application/zip" },
    customMetadata: { jobId, uploadType }
  });
  const timestamp = now();
  await env.DB.prepare(
    "INSERT INTO jobs (id,status,upload_name,upload_type,source_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(jobId, "queued", safeName(file.name), uploadType, sourceKey, timestamp, timestamp).run();

  try {
    await githubDispatch(env, jobId);
  } catch (e) {
    await env.DB.prepare("UPDATE jobs SET status='error', error=?, updated_at=? WHERE id=?")
      .bind(String(e.message || e), now(), jobId).run();
    return json({ error: String(e.message || e), jobId }, 502);
  }
  return json({ jobId, status: "queued" }, 202);
}

async function handleRunnerSource(request, env, jobId) {
  if (!env.RUNNER_SECRET || request.headers.get("X-Runner-Secret") !== env.RUNNER_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  const row = await env.DB.prepare("SELECT source_key FROM jobs WHERE id=?").bind(jobId).first();
  if (!row) return json({ error: "Job not found" }, 404);
  const object = await env.BUILDS.get(row.source_key);
  if (!object) return json({ error: "Source archive missing" }, 404);
  return new Response(object.body, {
    headers: { "content-type": "application/zip", "cache-control": "no-store" }
  });
}

async function handleRunnerUpdate(request, env, jobId) {
  if (!env.RUNNER_SECRET || request.headers.get("X-Runner-Secret") !== env.RUNNER_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  const body = await request.json();
  const status = ["building", "success", "error"].includes(body.status) ? body.status : null;
  if (!status) return json({ error: "Invalid status" }, 400);
  const log = String(body.log || "").slice(-30000);
  await env.DB.prepare("UPDATE jobs SET status=?, log=?, error=?, updated_at=? WHERE id=?")
    .bind(status, log, body.error ? String(body.error).slice(0, 2000) : null, now(), jobId).run();
  return json({ ok: true });
}

async function handleRunnerApk(request, env, jobId) {
  if (!env.RUNNER_SECRET || request.headers.get("X-Runner-Secret") !== env.RUNNER_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  const row = await env.DB.prepare("SELECT id FROM jobs WHERE id=?").bind(jobId).first();
  if (!row) return json({ error: "Job not found" }, 404);
  const key = `apks/${jobId}/app-debug.apk`;
  await env.BUILDS.put(key, request.body, {
    httpMetadata: { contentType: "application/vnd.android.package-archive" },
    customMetadata: { jobId }
  });
  await env.DB.prepare("UPDATE jobs SET status='success', apk_key=?, updated_at=? WHERE id=?")
    .bind(key, now(), jobId).run();
  return json({ ok: true });
}

async function handleJob(env, jobId) {
  const row = await env.DB.prepare(
    "SELECT id,status,upload_name,upload_type,log,error,created_at,updated_at,apk_key FROM jobs WHERE id=?"
  ).bind(jobId).first();
  if (!row) return json({ error: "Job not found" }, 404);
  return json({
    ...row,
    downloadUrl: row.apk_key ? `/api/jobs/${jobId}/download` : null
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/upload") return handleUpload(request, env);

    const sourceMatch = url.pathname.match(/^\/api\/runner\/([^/]+)\/source$/);
    if (request.method === "GET" && sourceMatch) return handleRunnerSource(request, env, sourceMatch[1]);

    const updateMatch = url.pathname.match(/^\/api\/runner\/([^/]+)\/status$/);
    if (request.method === "POST" && updateMatch) return handleRunnerUpdate(request, env, updateMatch[1]);

    const apkMatch = url.pathname.match(/^\/api\/runner\/([^/]+)\/apk$/);
    if (request.method === "PUT" && apkMatch) return handleRunnerApk(request, env, apkMatch[1]);

    const downloadMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/download$/);
    if (request.method === "GET" && downloadMatch) {
      const row = await env.DB.prepare("SELECT apk_key FROM jobs WHERE id=?").bind(downloadMatch[1]).first();
      if (!row?.apk_key) return json({ error: "APK is not ready." }, 404);
      const object = await env.BUILDS.get(row.apk_key);
      if (!object) return json({ error: "APK file not found." }, 404);
      return new Response(object.body, {
        headers: {
          "content-type": "application/vnd.android.package-archive",
          "content-disposition": 'attachment; filename="SONTEEN-app-debug.apk"',
          "cache-control": "no-store"
        }
      });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) return handleJob(env, jobMatch[1]);

    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  }
};
