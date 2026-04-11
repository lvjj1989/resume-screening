const API = "";

const ICON_FILE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ICON_FOLDER = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ICON_ARCHIVE = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 7h16v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M4 11h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

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
let isArchiveView = false;
let archiveRelPath = "";

function renderFolderCard(f, list) {
  if (f.is_archive) {
    const div = document.createElement("div");
    div.className = "folder-card folder-card--archive";
    div.setAttribute("role", "button");
    div.setAttribute("tabindex", "0");
    div.innerHTML = `
        <div class="folder-card-icon folder-card-icon--archive">${ICON_ARCHIVE}</div>
        <div class="folder-card-body">
          <h3 class="folder-card-title">${escapeHtml(f.name)}</h3>
          <p class="folder-card-desc folder-card-desc--archive">删除的简历与整夹归档会集中保存在此，与业务文件夹区分展示。</p>
          <div class="folder-card-stats">
            <span class="stat-pill stat-pill-archive">共 <strong>${f.resume_count}</strong> 个归档文件</span>
            <span class="stat-pill stat-pill-archive-meta">系统目录 · 不可删除</span>
          </div>
        </div>
        <div class="folder-card-side folder-card-side--archive">
          <div class="folder-card-arrow folder-card-arrow--archive" aria-hidden="true">→</div>
        </div>
      `;
    const go = () => openArchive("");
    div.addEventListener("click", go);
    div.addEventListener("keydown", (e) => {
      if (e.target !== div) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });
    list.appendChild(div);
    return;
  }

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
          <button type="button" class="folder-card-rename" aria-label="重命名文件夹">重命名</button>
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
  div.querySelector(".folder-card-rename").addEventListener("click", (e) => {
    e.stopPropagation();
    renameFolderById(f.id, f.name);
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
}

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
    const userFolders = folders.filter((x) => !x.is_archive);
    if (userFolders.length === 0) {
      const tip = document.createElement("p");
      tip.className = "folder-grid-tip";
      tip.innerHTML =
        "暂无业务文件夹<span class=\"empty-strong\">可在上方新建；列表底部为「历史人才库」</span>";
      list.appendChild(tip);
    }
    folders.forEach((f) => renderFolderCard(f, list));
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

async function renameFolderById(folderId, currentName) {
  const n = window.prompt("请输入新的文件夹名称：", currentName);
  if (n === null) return;
  const name = n.trim();
  if (!name) {
    toast("名称不能为空");
    return;
  }
  if (name === currentName) return;
  try {
    await api("PATCH", `/api/folders/${folderId}`, { name });
    toast("已重命名");
    if (currentFolderId === folderId) {
      currentFolderName = name;
      document.getElementById("resume-folder-title").textContent = name;
    }
    loadFolders();
  } catch (e) {
    toast(e.message);
  }
}

async function deleteFolderById(folderId, displayName) {
  const label = displayName ? `「${displayName}」` : "该文件夹";
  if (
    !confirm(
      `确定删除${label}？文件夹内所有简历文件将整体移入「历史人才库」，列表中的记录会删除（文件可在历史人才库中找回）。`,
    )
  )
    return;
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
  if (isArchiveView || !currentFolderId) return;
  await deleteFolderById(currentFolderId, currentFolderName);
}

function syncResumeChrome() {
  const del = document.getElementById("btn-delete-folder");
  const ren = document.getElementById("btn-rename-folder");
  const upload = document.getElementById("resume-upload-label");
  const hint = document.getElementById("resume-hint");
  const crumb = document.getElementById("archive-breadcrumb");
  const titleEl = document.getElementById("list-shell-title");
  const subEl = document.getElementById("list-shell-hint");
  if (isArchiveView) {
    del.classList.add("hidden");
    ren.classList.add("hidden");
    upload.classList.add("hidden");
    hint.innerHTML =
      "此处为<strong>已删除</strong>的简历与整夹归档，仅可浏览、预览与下载，不会在业务列表中统计。";
    titleEl.textContent = "归档内容";
    subEl.textContent = archiveRelPath ? "子目录" : "根目录全部条目";
    if (archiveRelPath) {
      crumb.textContent = "当前位置：" + archiveRelPath;
      crumb.classList.remove("hidden");
    } else {
      crumb.textContent = "";
      crumb.classList.add("hidden");
    }
  } else {
    del.classList.remove("hidden");
    ren.classList.remove("hidden");
    upload.classList.remove("hidden");
    hint.innerHTML =
      "列表按<strong>下载次数</strong>优先排序；每次下载会更新计数并自动靠前展示。";
    titleEl.textContent = "简历列表";
    subEl.textContent = "支持 PDF、Word、图片";
    crumb.classList.add("hidden");
    crumb.textContent = "";
  }
}

function setNormalTableHead() {
  const theadRow = document.getElementById("resume-thead-row");
  theadRow.innerHTML = `
                <th class="col-file">文件</th>
                <th class="col-num">下载</th>
                <th class="col-time">上传时间</th>
                <th class="col-actions">操作</th>
              `;
}

function setArchiveTableHead() {
  const theadRow = document.getElementById("resume-thead-row");
  theadRow.innerHTML = `
                <th class="col-file">名称</th>
                <th class="col-archive-type">类型</th>
                <th class="col-time">修改时间</th>
                <th class="col-actions">操作</th>
              `;
}

function formatBytes(n) {
  if (n == null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function showFolders() {
  currentFolderId = null;
  currentFolderName = "";
  isArchiveView = false;
  archiveRelPath = "";
  showView("folders");
  loadFolders();
}

async function openArchive(rel) {
  isArchiveView = true;
  archiveRelPath = rel || "";
  currentFolderId = null;
  currentFolderName = "";
  document.getElementById("resume-folder-title").textContent = "历史人才库";
  syncResumeChrome();
  showView("resumes");
  await loadArchiveList();
}

async function openFolder(id, name) {
  isArchiveView = false;
  archiveRelPath = "";
  currentFolderId = id;
  currentFolderName = name;
  document.getElementById("resume-folder-title").textContent = name;
  syncResumeChrome();
  showView("resumes");
  await loadResumes();
}

async function loadArchiveList() {
  const tbody = document.getElementById("resume-tbody");
  const cards = document.getElementById("resume-cards");
  setArchiveTableHead();
  tbody.innerHTML = "";
  cards.innerHTML = "";
  const q = archiveRelPath ? `?path=${encodeURIComponent(archiveRelPath)}` : "";
  try {
    const items = await api("GET", `/api/archive/list${q}`);
    if (!items.length) {
      tbody.innerHTML =
        '<tr><td colspan="4" style="padding:0;border:none"><div class="empty">暂无归档文件<span class="empty-strong">删除简历或文件夹后会出现在此</span></div></td></tr>';
      cards.innerHTML =
        '<p class="empty">暂无归档<span class="empty-strong">删除业务侧内容后将归集于此</span></p>';
      return;
    }
    items.forEach((item) => {
      const typeLabel = item.type === "dir" ? "文件夹" : `文件 · ${formatBytes(item.size)}`;
      const tr = document.createElement("tr");
      if (item.type === "dir") {
        tr.innerHTML = `
        <td class="col-file">
          <div class="file-cell">
            <span class="file-icon file-icon--dir">${ICON_FOLDER}</span>
            <span class="file-name">${escapeHtml(item.name)}</span>
          </div>
        </td>
        <td class="col-archive-type">${typeLabel}</td>
        <td class="col-time time-cell">${formatDate(item.modified_at)}</td>
        <td class="col-actions">
          <div class="resume-actions">
            <button type="button" class="btn btn-sm btn-action-preview archive-open-dir-btn" data-rel="${escapeHtmlAttr(item.rel_path)}">打开</button>
          </div>
        </td>`;
      } else {
        const enc = encodeURIComponent(item.rel_path);
        tr.innerHTML = `
        <td class="col-file">
          <div class="file-cell">
            <span class="file-icon">${ICON_FILE}</span>
            <span class="file-name">${escapeHtml(item.name)}</span>
          </div>
        </td>
        <td class="col-archive-type">${typeLabel}</td>
        <td class="col-time time-cell">${formatDate(item.modified_at)}</td>
        <td class="col-actions">
          <div class="resume-actions">
            <button type="button" class="btn btn-sm btn-action-preview archive-preview-btn" data-rel="${escapeHtmlAttr(item.rel_path)}">预览</button>
            <a class="btn btn-sm btn-action-download" href="${API}/api/archive/download?path=${enc}" download>下载</a>
          </div>
        </td>`;
      }
      tbody.appendChild(tr);

      const card = document.createElement("div");
      card.className = "resume-card resume-card--archive";
      if (item.type === "dir") {
        card.innerHTML = `
        <div class="resume-card-head">
          <span class="file-icon file-icon--dir">${ICON_FOLDER}</span>
          <div class="resume-card-name">${escapeHtml(item.name)}</div>
        </div>
        <div class="resume-card-meta">${typeLabel} · ${formatDate(item.modified_at)}</div>
        <div class="resume-actions">
          <button type="button" class="btn btn-sm btn-action-preview archive-open-dir-btn" data-rel="${escapeHtmlAttr(item.rel_path)}">打开</button>
        </div>`;
      } else {
        const enc = encodeURIComponent(item.rel_path);
        card.innerHTML = `
        <div class="resume-card-head">
          <span class="file-icon">${ICON_FILE}</span>
          <div class="resume-card-name">${escapeHtml(item.name)}</div>
        </div>
        <div class="resume-card-meta">${typeLabel} · ${formatDate(item.modified_at)}</div>
        <div class="resume-actions">
          <button type="button" class="btn btn-sm btn-action-preview archive-preview-btn" data-rel="${escapeHtmlAttr(item.rel_path)}">预览</button>
          <a class="btn btn-sm btn-action-download" href="${API}/api/archive/download?path=${enc}" download>下载</a>
        </div>`;
      }
      cards.appendChild(card);
    });

    document.querySelectorAll(".archive-open-dir-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        archiveRelPath = btn.getAttribute("data-rel") || "";
        syncResumeChrome();
        loadArchiveList();
      });
    });
    document.querySelectorAll(".archive-preview-btn").forEach((btn) => {
      btn.addEventListener("click", () => openArchivePreview(btn.getAttribute("data-rel") || ""));
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="padding:0;border:none"><div class="empty">加载失败<span class="empty-strong">${escapeHtml(e.message)}</span></div></td></tr>`;
    cards.innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
  }
}

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function openArchivePreview(relPath) {
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

  const url = `${API}/api/archive/preview?path=${encodeURIComponent(relPath)}`;
  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error("无法加载预览");
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      return res.blob().then((blob) => ({ blob, ct }));
    })
    .then(({ blob, ct }) => {
      const objUrl = URL.createObjectURL(blob);
      body.innerHTML = "";
      if (ct.includes("pdf")) {
        const iframe = document.createElement("iframe");
        iframe.src = objUrl;
        iframe.title = "PDF 预览";
        body.appendChild(iframe);
      } else if (ct.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = objUrl;
        img.alt = "预览";
        body.appendChild(img);
      } else {
        body.innerHTML = `<div class="preview-fallback">该类型无法在浏览器内预览，请使用<a href="${API}/api/archive/download?path=${encodeURIComponent(relPath)}">下载</a>查看。</div>`;
        URL.revokeObjectURL(objUrl);
      }
    })
    .catch((e) => {
      body.innerHTML = `<div class="preview-fallback">${escapeHtml(e.message)}</div>`;
    });
}

async function loadResumes() {
  const tbody = document.getElementById("resume-tbody");
  const cards = document.getElementById("resume-cards");
  setNormalTableHead();
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
  if (isArchiveView || !file || !currentFolderId) return;
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
document.getElementById("btn-back").addEventListener("click", () => {
  if (isArchiveView && archiveRelPath) {
    const parts = archiveRelPath.split("/").filter(Boolean);
    parts.pop();
    archiveRelPath = parts.join("/");
    syncResumeChrome();
    loadArchiveList();
    return;
  }
  showFolders();
});
document.getElementById("btn-delete-folder").addEventListener("click", deleteCurrentFolder);
document.getElementById("btn-rename-folder").addEventListener("click", () => {
  if (isArchiveView || !currentFolderId) return;
  renameFolderById(currentFolderId, currentFolderName);
});
document.getElementById("file-upload").addEventListener("change", uploadResume);
document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});
document.getElementById("modal-panel").addEventListener("click", (e) => e.stopPropagation());

loadFolders();
