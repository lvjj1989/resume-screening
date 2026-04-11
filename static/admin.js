const API = "/jianli";

let resumeOffset = 0;
const resumeLimit = 50;
let resumeTotal = 0;

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2600);
}

async function api(method, path, body) {
  const opts = { method };
  if (body != null) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      if (j.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch (_) {}
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function sqlCellStr(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function renderSqlResult(data) {
  const el = document.getElementById("sql-result");
  el.hidden = false;
  if (data.kind === "select") {
    const cols = data.columns;
    const thead = `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr>`;
    const tbody = data.rows
      .map(
        (row) =>
          `<tr>${cols.map((c) => `<td>${escapeHtml(sqlCellStr(row[c]))}</td>`).join("")}</tr>`
      )
      .join("");
    el.innerHTML = `<p class="admin-sql-meta">返回 ${data.row_count} 行</p><div class="admin-table-wrap"><table class="admin-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
  } else {
    el.innerHTML = `<p class="admin-sql-meta">已执行，影响行数：<strong>${data.rowcount}</strong>（SQLite 部分语句可能为 -1）</p>`;
  }
}

async function loadOverview() {
  const data = await api("GET", "/api/admin/overview");
  const meta = document.getElementById("admin-meta");
  meta.innerHTML = `
    <p class="admin-meta-row"><strong>数据库文件</strong>${escapeHtml(data.db_path)}</p>
    <p class="admin-meta-row"><strong>简历记录总数</strong>${data.resume_total}</p>
    <p class="admin-meta-row"><strong>文件夹数</strong>${data.folders.length}</p>
  `;

  const tbody = document.getElementById("tbody-folders");
  tbody.innerHTML = "";
  for (const f of data.folders) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${f.id}</td>
      <td>${escapeHtml(f.name)}</td>
      <td>${f.resume_count}</td>
      <td>${escapeHtml(f.created_at || "—")}</td>
      <td class="admin-actions">
        <button type="button" class="btn btn-ghost btn-sm act-rename" data-id="${f.id}">重命名</button>
        <button type="button" class="btn btn-danger-outline btn-sm act-del-folder" data-id="${f.id}" data-folder-name="${encodeURIComponent(f.name)}">删除</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  const sel = document.getElementById("filter-folder");
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部</option>';
  for (const f of data.folders) {
    const o = document.createElement("option");
    o.value = String(f.id);
    o.textContent = `${f.name} (#${f.id})`;
    sel.appendChild(o);
  }
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;

  tbody.querySelectorAll(".act-rename").forEach((btn) => {
    btn.addEventListener("click", () => renameFolder(Number(btn.dataset.id)));
  });
  tbody.querySelectorAll(".act-del-folder").forEach((btn) => {
    btn.addEventListener("click", () =>
      deleteFolder(Number(btn.dataset.id), btn.dataset.folderName ? decodeURIComponent(btn.dataset.folderName) : "")
    );
  });
}

async function loadResumes() {
  const folderId = document.getElementById("filter-folder").value;
  const q = new URLSearchParams({ offset: String(resumeOffset), limit: String(resumeLimit) });
  if (folderId) q.set("folder_id", folderId);
  const data = await api("GET", `/api/admin/resumes?${q}`);
  resumeTotal = data.total;
  const tbody = document.getElementById("tbody-resumes");
  tbody.innerHTML = "";
  for (const r of data.items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.id}</td>
      <td>${r.folder_id}</td>
      <td title="${escapeHtml(r.original_filename)}">${escapeHtml(r.original_filename)}</td>
      <td class="mono" title="${escapeHtml(r.stored_filename)}">${escapeHtml(r.stored_filename)}</td>
      <td>${r.download_count}</td>
      <td>${escapeHtml(r.created_at || "—")}</td>
      <td class="admin-actions">
        <button type="button" class="btn btn-ghost btn-sm act-edit-dl" data-id="${r.id}" data-dl="${r.download_count}">改下载数</button>
        <button type="button" class="btn btn-danger-outline btn-sm act-del-resume" data-id="${r.id}">删记录</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  document.getElementById("page-info").textContent = `第 ${resumeOffset + 1}–${Math.min(resumeOffset + data.items.length, data.total)} 条，共 ${data.total} 条`;
  document.getElementById("btn-prev").disabled = resumeOffset <= 0;
  document.getElementById("btn-next").disabled = resumeOffset + data.items.length >= data.total;

  tbody.querySelectorAll(".act-del-resume").forEach((btn) => {
    btn.addEventListener("click", () => deleteResume(Number(btn.dataset.id)));
  });
  tbody.querySelectorAll(".act-edit-dl").forEach((btn) => {
    btn.addEventListener("click", () => editDownloadCount(Number(btn.dataset.id), Number(btn.dataset.dl)));
  });
}

async function renameFolder(id) {
  const name = window.prompt("新文件夹名称", "");
  if (name == null) return;
  const n = name.trim();
  if (!n) {
    toast("名称不能为空");
    return;
  }
  try {
    await api("PATCH", `/api/folders/${id}`, { name: n });
    toast("已重命名");
    await loadOverview();
    await loadResumes();
  } catch (e) {
    toast(e.message || "失败");
  }
}

async function deleteFolder(id, displayName) {
  const name = displayName || `#${id}`;
  if (!window.confirm(`确定删除文件夹「${name}」？其中简历将按原逻辑迁入历史人才库。`)) return;
  try {
    await api("DELETE", `/api/folders/${id}`);
    toast("已删除文件夹");
    resumeOffset = 0;
    await loadOverview();
    await loadResumes();
  } catch (e) {
    toast(e.message || "失败");
  }
}

async function deleteResume(id) {
  if (!window.confirm(`确定删除简历记录 #${id}？文件将迁入历史人才库。`)) return;
  try {
    await api("DELETE", `/api/resumes/${id}`);
    toast("已删除");
    await loadOverview();
    await loadResumes();
  } catch (e) {
    toast(e.message || "失败");
  }
}

async function editDownloadCount(id, current) {
  const v = window.prompt("下载次数（非负整数）", String(current));
  if (v == null) return;
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 0) {
    toast("请输入有效非负整数");
    return;
  }
  try {
    await api("PATCH", `/api/admin/resumes/${id}`, { download_count: n });
    toast("已更新");
    await loadResumes();
    await loadOverview();
  } catch (e) {
    toast(e.message || "失败");
  }
}

document.getElementById("btn-refresh").addEventListener("click", async () => {
  try {
    await loadOverview();
    toast("已刷新");
  } catch (e) {
    toast(e.message || "失败");
  }
});

document.getElementById("btn-load-resumes").addEventListener("click", async () => {
  resumeOffset = 0;
  try {
    await loadResumes();
  } catch (e) {
    toast(e.message || "失败");
  }
});

document.getElementById("btn-prev").addEventListener("click", async () => {
  resumeOffset = Math.max(0, resumeOffset - resumeLimit);
  try {
    await loadResumes();
  } catch (e) {
    toast(e.message || "失败");
  }
});

document.getElementById("btn-next").addEventListener("click", async () => {
  if (resumeOffset + resumeLimit < resumeTotal) resumeOffset += resumeLimit;
  try {
    await loadResumes();
  } catch (e) {
    toast(e.message || "失败");
  }
});

document.getElementById("btn-sql-example").addEventListener("click", () => {
  document.getElementById("sql-input").value =
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('folders', 'resumes');";
});

document.getElementById("btn-run-sql").addEventListener("click", async () => {
  const sql = document.getElementById("sql-input").value.trim();
  if (!sql) {
    toast("请输入 SQL");
    return;
  }
  const out = document.getElementById("sql-result");
  out.hidden = false;
  out.innerHTML = '<p class="admin-sql-meta">执行中…</p>';
  try {
    const data = await api("POST", "/api/admin/sql", { sql });
    renderSqlResult(data);
    toast(data.kind === "select" ? `已查询 ${data.row_count} 行` : "已执行并提交");
    try {
      await loadOverview();
      await loadResumes();
    } catch (_) {}
  } catch (e) {
    out.innerHTML = `<div class="admin-sql-error">${escapeHtml(e.message || "失败")}</div>`;
    toast(e.message || "失败");
  }
});

(async () => {
  try {
    await loadOverview();
    await loadResumes();
  } catch (e) {
    toast(e.message || "加载失败");
    document.getElementById("admin-meta").innerHTML = `<p class="admin-meta-row">${escapeHtml(e.message || "加载失败")}</p>`;
  }
})();
