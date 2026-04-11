const API = "";

const ICON_FILE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ICON_FOLDER = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2600);
}

async function api(method, path, body, isForm) {
  const opts = { method };
  if (body != null) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
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

function showView(name) {
  document.getElementById("view-folders").classList.toggle("hidden", name !== "folders");
  document.getElementById("view-resumes").classList.toggle("hidden", name !== "resumes");
}

let currentFolderId = null;
let currentFolderName = "";

async function loadFolders() {
  const list = document.getElementById("folder-list");
  list.innerHTML = "";
  try {
    const folders = await api("GET", "/api/folders");
    if (!folders.length) {
      list.innerHTML =
        '<p class="empty">还没有文件夹<span class="empty-strong">在上方输入名称并点击「新建文件夹」即可开始</span></p>';
      return;
    }
    folders.forEach((f) => {
      const div = document.createElement("div");
      div.className = "folder-card";
      div.setAttribute("role", "button");
      div.setAttribute("tabindex", "0");
      div.innerHTML = `
        <div class="folder-card-icon">${ICON_FOLDER}</div>
        <div class="folder-card-body">
          <h3 class="folder-card-title">${escapeHtml(f.name)}</h3>
          <div class="folder-card-stats">
            <span class="stat-pill stat-pill-neutral">共 <strong>${f.resume_count}</strong> 份简历</span>
            <span class="stat-pill stat-pill-warn">未下载 <strong>${f.undownloaded_count}</strong></span>
          </div>
        </div>
        <div class="folder-card-side">
          <button type="button" class="folder-card-delete" aria-label="删除文件夹">删除</button>
          <div class="folder-card-arrow" aria-hidden="true">→</div>
        </div>
      `;
      const go = () => openFolder(f.id, f.name);
      div.addEventListener("click", go);
      div.addEventListener("keydown", (e) => {
        if (e.target !== div) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
      const delBtn = div.querySelector(".folder-card-delete");
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteFolderById(f.id, f.name);
      });
      delBtn.addEventListener("keydown", (e) => {
        e.stopPropagation();
      });
      list.appendChild(div);
    });
  } catch (e) {
    list.innerHTML = `<p class="empty">加载失败：${escapeHtml(e.message)}</p>`;
  }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function createFolder() {
  const input = document.getElementById("new-folder-name");
  const name = input.value.trim();
  if (!name) {
    toast("请输入文件夹名称");
    return;
  }
  try {
    await api("POST", "/api/folders", { name });
    input.value = "";
    toast("已创建");
    loadFolders();
  } catch (e) {
    toast(e.message);
  }
}

async function deleteFolderById(folderId, displayName) {
  const label = displayName ? `「${displayName}」` : "该文件夹";
  if (!confirm(`确定删除${label}及其中的全部简历？此操作不可恢复。`)) return;
  try {
    await api("DELETE", `/api/folders/${folderId}`);
    toast("文件夹已删除");
    if (currentFolderId === folderId) {
      showFolders();
    } else {
      loadFolders();
    }
  } catch (e) {
    toast(e.message);
  }
}

async function deleteCurrentFolder() {
  if (!currentFolderId) return;
  await deleteFolderById(currentFolderId, currentFolderName);
}

function showFolders() {
  currentFolderId = null;
  showView("folders");
  loadFolders();
}

async function openFolder(id, name) {
  currentFolderId = id;
  currentFolderName = name;
  document.getElementById("resume-folder-title").textContent = name;
  showView("resumes");
  await loadResumes();
}

async function loadResumes() {
  const tbody = document.getElementById("resume-tbody");
  const cards = document.getElementById("resume-cards");
  tbody.innerHTML = "";
  cards.innerHTML = "";
  if (!currentFolderId) return;
  try {
    const items = await api("GET", `/api/folders/${currentFolderId}/resumes`);
    if (!items.length) {
      tbody.innerHTML =
        '<tr><td colspan="4" style="padding:0;border:none"><div class="empty">暂无简历<span class="empty-strong">点击「上传简历」添加 PDF、Word 或图片</span></div></td></tr>';
      cards.innerHTML =
        '<p class="empty">暂无简历<span class="empty-strong">点击「上传简历」添加文件</span></p>';
      return;
    }
    items.forEach((r) => {
      const hot = r.download_count > 0 ? " hot" : "";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="col-file">
          <div class="file-cell">
            <span class="file-icon">${ICON_FILE}</span>
            <span class="file-name">${escapeHtml(r.original_filename)}</span>
          </div>
        </td>
        <td class="col-num"><span class="download-badge${hot}">${r.download_count}</span></td>
        <td class="col-time time-cell">${formatDate(r.created_at)}</td>
        <td class="col-actions">
          <div class="resume-actions">
            <button type="button" class="btn btn-sm btn-action-preview preview-btn" data-id="${r.id}">预览</button>
            <a class="btn btn-sm btn-action-download download-link" href="${API}/api/resumes/${r.id}/download" download>下载</a>
            <button type="button" class="btn btn-sm btn-action-delete delete-resume-btn" data-id="${r.id}">删除</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);

      const card = document.createElement("div");
      card.className = "resume-card";
      card.innerHTML = `
        <div class="resume-card-head">
          <span class="file-icon">${ICON_FILE}</span>
          <div class="resume-card-name">${escapeHtml(r.original_filename)}</div>
        </div>
        <div class="resume-card-meta">
          <span class="download-badge${hot}">${r.download_count} 次下载</span>
          <span>${formatDate(r.created_at)}</span>
        </div>
        <div class="resume-actions">
          <button type="button" class="btn btn-sm btn-action-preview preview-btn" data-id="${r.id}">预览</button>
          <a class="btn btn-sm btn-action-download download-link" href="${API}/api/resumes/${r.id}/download" download>下载</a>
          <button type="button" class="btn btn-sm btn-action-delete delete-resume-btn" data-id="${r.id}">删除</button>
        </div>
      `;
      cards.appendChild(card);
    });

    document.querySelectorAll(".preview-btn").forEach((btn) => {
      btn.addEventListener("click", () => openPreview(Number(btn.dataset.id)));
    });
    document.querySelectorAll(".delete-resume-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteResume(Number(btn.dataset.id)));
    });
    document.querySelectorAll(".download-link").forEach((a) => {
      a.addEventListener("click", () => {
        setTimeout(() => loadResumes(), 600);
      });
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="padding:0;border:none"><div class="empty">加载失败<span class="empty-strong">${escapeHtml(e.message)}</span></div></td></tr>`;
    cards.innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
  }
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

async function deleteResume(id) {
  if (!confirm("确定删除该简历？")) return;
  try {
    await api("DELETE", `/api/resumes/${id}`);
    toast("已删除");
    loadResumes();
    loadFolders();
  } catch (e) {
    toast(e.message);
  }
}

async function uploadResume(ev) {
  const input = ev.target;
  const file = input.files && input.files[0];
  input.value = "";
  if (!file || !currentFolderId) return;
  try {
    const res = await fetch(`${API}/api/folders/${currentFolderId}/resumes`, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name || "resume"),
      },
      body: file,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const j = await res.json();
        if (j.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      } catch (_) {}
      throw new Error(detail);
    }
    toast("上传成功");
    loadResumes();
    loadFolders();
  } catch (e) {
    toast(e.message);
  }
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  const body = document.getElementById("modal-body");
  const iframe = body.querySelector("iframe");
  const img = body.querySelector("img");
  const u = iframe?.src || img?.src;
  if (u && u.startsWith("blob:")) URL.revokeObjectURL(u);
  body.innerHTML = "";
}

function openPreview(resumeId) {
  const modal = document.getElementById("modal");
  const title = document.getElementById("modal-title");
  const body = document.getElementById("modal-body");
  const prevIframe = body.querySelector("iframe");
  const prevImg = body.querySelector("img");
  const prevU = prevIframe?.src || prevImg?.src;
  if (prevU && prevU.startsWith("blob:")) URL.revokeObjectURL(prevU);
  title.textContent = "预览";
  body.innerHTML = '<p class="preview-fallback">加载中…</p>';
  modal.classList.remove("hidden");

  fetch(`${API}/api/resumes/${resumeId}/preview`)
    .then((res) => {
      if (!res.ok) throw new Error("无法加载预览");
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      return res.blob().then((blob) => ({ blob, ct }));
    })
    .then(({ blob, ct }) => {
      const url = URL.createObjectURL(blob);
      body.innerHTML = "";
      if (ct.includes("pdf")) {
        const iframe = document.createElement("iframe");
        iframe.src = url;
        iframe.title = "PDF 预览";
        body.appendChild(iframe);
      } else if (ct.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "预览";
        body.appendChild(img);
      } else {
        body.innerHTML = `<div class="preview-fallback">该类型无法在浏览器内预览，请使用<a href="${API}/api/resumes/${resumeId}/download">下载</a>查看。</div>`;
        URL.revokeObjectURL(url);
      }
    })
    .catch((e) => {
      body.innerHTML = `<div class="preview-fallback">${escapeHtml(e.message)}</div>`;
    });
}

document.getElementById("btn-create-folder").addEventListener("click", createFolder);
document.getElementById("new-folder-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") createFolder();
});
document.getElementById("btn-back").addEventListener("click", showFolders);
document.getElementById("btn-delete-folder").addEventListener("click", deleteCurrentFolder);
document.getElementById("file-upload").addEventListener("change", uploadResume);
document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});
document.getElementById("modal-panel").addEventListener("click", (e) => e.stopPropagation());

loadFolders();
