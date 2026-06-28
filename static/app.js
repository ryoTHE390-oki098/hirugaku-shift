const app = document.querySelector("#app");
let state = {};
let route = location.pathname.startsWith("/admin") ? "adminHome" : "home";
let adminToken = sessionStorage.getItem("adminToken") || "";
let toastTimer;
let currentToast;
let monthDateDraft = [];
let builderCandidates = [];
let builderSelectedMonthId = null;
let builderSelectedDate = null;
let supabaseStatus = null;
let syncProgressTimer = null;
const onlineConfig = window.HIRUGAKU_ONLINE || {};
const localAdminMode = location.pathname.startsWith("/admin") && ["127.0.0.1", "localhost"].includes(location.hostname);
const onlineMode = Boolean(!localAdminMode && onlineConfig.enabled && onlineConfig.supabaseUrl && onlineConfig.supabaseAnonKey);
const supabaseBaseUrl = onlineMode ? onlineConfig.supabaseUrl.replace(/\/$/, "") : "";

const today = new Date();
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthLabel = (m) => `${m.year}年${m.month}月`;
const dateLabel = (date) => {
  const d = new Date(`${date}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const drive = (member) => member?.can_drive ? " 🚗" : "";
const statusText = { draft: "非公開", open: "回答受付中", closed: "締切" };
const availabilityText = { ok: "〇", maybe: "△", ng: "×" };

function supabaseHeaders(extra = {}) {
  return {
    apikey: onlineConfig.supabaseAnonKey,
    Authorization: `Bearer ${onlineConfig.supabaseAnonKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function supabaseRequest(table, query = "select=*", options = {}) {
  const url = `${supabaseBaseUrl}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    ...options,
    headers: supabaseHeaders(options.headers || {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "オンラインDBとの通信に失敗しました");
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function onlineBootstrap() {
  const [members, venues, months, surveyDates, responses, responseDays, assignments] = await Promise.all([
    supabaseRequest("members", "select=*&active=eq.true&order=name.asc"),
    supabaseRequest("venues", "select=*&order=id.asc"),
    supabaseRequest("months", "select=*&or=(survey_status.neq.draft,schedule_published.eq.true)&order=year.desc,month.desc"),
    supabaseRequest("survey_dates", "select=*&order=date.asc"),
    supabaseRequest("responses", "select=*&order=updated_at.desc"),
    supabaseRequest("response_days", "select=*&order=date.asc"),
    supabaseRequest("assignments", "select=*&order=date.asc,venue_id.asc,slot.asc"),
  ]);
  const memberNameById = Object.fromEntries(members.map((m) => [m.id, m.name]));
  return {
    members,
    venues,
    months,
    survey_dates: surveyDates,
    responses: responses.map((r) => ({ ...r, member_name: memberNameById[r.member_id] || "" })),
    response_days: responseDays,
    assignments,
  };
}

async function onlineSaveResponse(payload) {
  const saved = await supabaseRequest("responses", "on_conflict=month_id,member_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([
      {
        month_id: Number(payload.month_id),
        member_id: Number(payload.member_id),
        updated_at: new Date().toISOString(),
      },
    ]),
  });
  const responseId = saved?.[0]?.id;
  if (!responseId) throw new Error("回答の保存に失敗しました");

  await supabaseRequest("response_days", `response_id=eq.${responseId}`, {
    method: "DELETE",
  });

  const rows = Object.entries(payload.answers || {}).map(([date, availability]) => ({
    response_id: responseId,
    date,
    availability,
  }));
  if (rows.length) {
    await supabaseRequest("response_days", "", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(rows),
    });
  }
  return { ok: true };
}

async function onlineDeleteResponse(payload) {
  const found = await supabaseRequest(
    "responses",
    `select=id&month_id=eq.${Number(payload.month_id)}&member_id=eq.${Number(payload.member_id)}`
  );
  const responseId = found?.[0]?.id;
  if (!responseId) return { ok: true };

  await supabaseRequest("response_days", `response_id=eq.${responseId}`, {
    method: "DELETE",
  });
  await supabaseRequest("responses", `id=eq.${responseId}`, {
    method: "DELETE",
  });
  return { ok: true };
}

async function api(path, options = {}) {
  if (onlineMode && path === "/api/bootstrap") return onlineBootstrap();
  if (onlineMode && path === "/api/response") return onlineSaveResponse(JSON.parse(options.body || "{}"));
  if (onlineMode && path === "/api/response/delete") return onlineDeleteResponse(JSON.parse(options.body || "{}"));
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (adminToken) headers["X-Admin-Token"] = adminToken;
  const res = await fetch(path, {
    ...options,
    headers,
  });
  const data = await res.json();
  if (res.status === 401) {
    adminToken = "";
    sessionStorage.removeItem("adminToken");
    route = "adminLogin";
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || "保存に失敗しました");
  return data;
}

async function load() {
  state = await api("/api/bootstrap");
  render();
}

function go(next) {
  route = next;
  render();
}

function isAdminRoute(value) {
  return value.startsWith("admin") && value !== "adminLogin";
}

function showToast(message) {
  clearTimeout(toastTimer);
  currentToast?.remove();
  const el = document.createElement("div");
  currentToast = el;
  el.className = "toast";
  el.textContent = message;
  document.body.append(el);
  toastTimer = setTimeout(() => {
    el.remove();
    if (currentToast === el) currentToast = null;
  }, 2200);
}

function showSyncProgress(title = "同期中") {
  hideSyncProgress();
  const el = document.createElement("div");
  el.className = "sync-overlay";
  el.innerHTML = `
    <div class="sync-modal" role="status" aria-live="polite">
      <h2>${title}</h2>
      <p class="muted" id="syncProgressMessage">オンラインDBと同期しています。画面を閉じずにお待ちください。</p>
      <div class="sync-progress">
        <div id="syncProgressBar" class="sync-progress-bar" style="width: 0%"></div>
      </div>
      <div id="syncProgressPercent" class="sync-progress-percent">0%</div>
    </div>
  `;
  document.body.append(el);
  setSyncProgress(0, "同期を開始しています。");
  let progress = 0;
  syncProgressTimer = setInterval(() => {
    progress = Math.min(90, progress + (progress < 50 ? 6 : 3));
    setSyncProgress(progress, "同期中です。しばらくお待ちください。");
  }, 900);
}

function setSyncProgress(percent, message) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const bar = document.querySelector("#syncProgressBar");
  const label = document.querySelector("#syncProgressPercent");
  const text = document.querySelector("#syncProgressMessage");
  if (bar) bar.style.width = `${value}%`;
  if (label) label.textContent = `${value}%`;
  if (text && message) text.textContent = message;
}

function hideSyncProgress() {
  if (syncProgressTimer) {
    clearInterval(syncProgressTimer);
    syncProgressTimer = null;
  }
  document.querySelector(".sync-overlay")?.remove();
}

function waitForPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function finishSyncProgress(message) {
  if (!document.querySelector(".sync-overlay")) return;
  if (syncProgressTimer) {
    clearInterval(syncProgressTimer);
    syncProgressTimer = null;
  }
  setSyncProgress(100, message);
  await new Promise((resolve) => setTimeout(resolve, 700));
  hideSyncProgress();
}

function shell(title, content, nav = "") {
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="title">${title}</div>
        <div class="nav">${nav}</div>
      </header>
      ${content}
    </main>
  `;
}

function monthById(id) {
  return state.months.find((m) => m.id === Number(id));
}

function memberById(id) {
  return state.members.find((m) => m.id === Number(id));
}

function datesFor(monthId) {
  return state.survey_dates.filter((d) => d.month_id === Number(monthId));
}

function responseFor(monthId, memberId) {
  return state.responses.find((r) => r.month_id === Number(monthId) && r.member_id === Number(memberId));
}

function responseDays(responseId) {
  return state.response_days.filter((d) => d.response_id === Number(responseId));
}

function responseHistoryLabel(monthId, memberId) {
  const existing = responseFor(monthId, memberId);
  return existing ? `最終回答：${existing.updated_at}` : "未回答";
}

function responseStatusLabel(monthId, memberId) {
  return responseFor(monthId, memberId) ? "回答済み" : "未回答";
}

function visibleSurveys() {
  return state.months
    .filter((m) => m.survey_status === "open" || m.survey_status === "closed")
    .sort((a, b) => a.year - b.year || a.month - b.month);
}

function publishedScheduleMonths() {
  return state.months
    .filter((m) => m.schedule_published)
    .sort((a, b) => a.year - b.year || a.month - b.month);
}

function defaultScheduleMonth() {
  const published = publishedScheduleMonths();
  if (published.length === 0) return null;
  const current = published.find((m) => m.year === today.getFullYear() && m.month === today.getMonth() + 1);
  if (current) return current;
  return published.find((m) => m.year > today.getFullYear() || (m.year === today.getFullYear() && m.month >= today.getMonth() + 1)) || published[published.length - 1];
}

function renderHome() {
  shell(
    "昼学シフトシステム",
    `
      <section class="grid">
        <article class="panel">
          <h2>シフト希望</h2>
          <p class="muted">公開中の希望調査に回答・編集します。</p>
          <button class="primary" onclick="go('userSurvey')">開く</button>
        </article>
        <article class="panel">
          <h2>シフト表</h2>
          <p class="muted">公開済みのシフト表を確認します。</p>
          <button class="primary" onclick="go('userSchedule')">開く</button>
        </article>
      </section>
    `
  );
}

function renderAdminLogin() {
  shell(
    "管理者ログイン",
    `
      <section class="panel form">
        <h2>管理者パスワード</h2>
        <label class="field-label">パスワード
          <input id="adminPassword" type="password" autocomplete="current-password" onkeydown="if(event.key === 'Enter') loginAdmin()">
        </label>
        <button class="primary" onclick="loginAdmin()">ログイン</button>
      </section>
    `,
    `<button onclick="go('home')">戻る</button>`
  );
  setTimeout(() => document.querySelector("#adminPassword")?.focus(), 0);
}

async function loginAdmin() {
  const password = document.querySelector("#adminPassword")?.value || "";
  try {
    const data = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    adminToken = data.token;
    sessionStorage.setItem("adminToken", adminToken);
    route = "adminHome";
    render();
  } catch (error) {
    showToast(error.message);
  }
}

function logoutAdmin() {
  adminToken = "";
  sessionStorage.removeItem("adminToken");
  route = "home";
  render();
}

function renderUserSurvey() {
  const surveys = visibleSurveys();
  const content = surveys.length
    ? `
      <section class="grid">
        ${surveys
          .map(
            (survey) => `
              <article class="panel">
                <h2>${monthLabel(survey)}シフト希望</h2>
                <p>回答期限：${survey.survey_deadline || "未設定"}</p>
                <p><span class="status">${statusText[survey.survey_status]}</span></p>
                <button class="primary" onclick="go('userAnswer:${survey.id}')">
                  ${survey.survey_status === "closed" ? "回答内容を見る" : "回答する / 編集する"}
                </button>
              </article>
            `
          )
          .join("")}
      </section>
    `
    : `<section class="panel"><h2>現在回答受付中のシフト希望調査はありません</h2></section>`;
  shell("シフト希望", content, `<button onclick="go('home')">戻る</button>`);
}

function renderUserAnswer(monthId) {
  const month = monthById(monthId);
  const locked = month.survey_status === "closed";
  const members = state.members.map((m) => `<option value="${m.id}">${m.name}${drive(m)}（${responseStatusLabel(month.id, m.id)}）</option>`).join("");
  shell(
    `${monthLabel(month)}シフト希望 回答ページ`,
    `
      <section class="panel form">
        <label>氏名を選択</label>
        <select id="answerMember">
          <option value="">選択してください</option>
          ${members}
        </select>
        <button class="primary" onclick="startAnswerForm(${month.id})">決定</button>
        <div id="answerForm"></div>
      </section>
    `,
    `<button onclick="go('userSurvey')">戻る</button>`
  );
  window.startAnswerForm = (id) => {
    if (!document.querySelector("#answerMember").value) {
      showToast("氏名を選択してください");
      return;
    }
    renderAnswerForm(id, locked);
  };
}

function renderAnswerForm(monthId, locked = false) {
  const memberId = Number(document.querySelector("#answerMember").value);
  const area = document.querySelector("#answerForm");
  if (!memberId) {
    area.innerHTML = "";
    return;
  }
  const existing = responseFor(monthId, memberId);
  const byDate = {};
  if (existing) responseDays(existing.id).forEach((d) => (byDate[d.date] = d.availability));
  area.innerHTML = `
    <div class="panel">
      <h3>${memberById(memberId).name}さんとして回答します</h3>
      <p class="muted">${existing ? `最終回答日時：${existing.updated_at}` : "未回答"}</p>
      ${datesFor(monthId)
        .map(
          (d) => `
            <div class="answer-day">
              <div class="answer-date">${dateLabel(d.date)}</div>
              <div class="answer-options" role="radiogroup" aria-label="${dateLabel(d.date)}の参加可否">
                ${["ok", "maybe", "ng"]
                  .map(
                    (v) => `
                      <label class="answer-option ${v}">
                        <input type="radio" name="day-${d.date}" value="${v}" ${byDate[d.date] === v ? "checked" : ""} ${locked ? "disabled" : ""}>
                        <span>${availabilityText[v]}</span>
                      </label>
                    `
                  )
                  .join("")}
              </div>
            </div>
          `
        )
        .join("")}
      <div class="actions">
        ${existing && !locked ? `<button class="danger" onclick="resetResponse(${monthId}, ${memberId})">回答をリセット</button>` : ""}
        ${locked ? "" : `<button class="primary" onclick="confirmResponse(${monthId}, ${memberId})">回答内容を確認</button>`}
      </div>
      <div id="confirmArea"></div>
    </div>
  `;
}

window.confirmResponse = (monthId, memberId) => {
  const answers = {};
  datesFor(monthId).forEach((d) => {
    const checked = document.querySelector(`[name="day-${d.date}"]:checked`);
    answers[d.date] = checked ? checked.value : "ng";
  });
  document.querySelector("#confirmArea").innerHTML = `
    <div class="panel">
      <h3>回答内容確認</h3>
      <div class="list">
        ${Object.entries(answers).map(([date, v]) => `<div>${dateLabel(date)}：${availabilityText[v]}</div>`).join("")}
      </div>
      <button class="primary" onclick='submitResponse(${monthId}, ${memberId}, ${JSON.stringify(JSON.stringify(answers))})'>送信する</button>
    </div>
  `;
};

window.resetResponse = async (monthId, memberId) => {
  const member = memberById(memberId);
  const month = monthById(monthId);
  const ok = confirm(`${member?.name || "選択中のメンバー"}さんの${month ? monthLabel(month) : ""}シフト希望の回答をリセットします。\n未回答の状態に戻ります。よろしいですか？`);
  if (!ok) return;
  try {
    await api("/api/response/delete", {
      method: "POST",
      body: JSON.stringify({ month_id: monthId, member_id: memberId }),
    });
    showToast("回答をリセットしました");
    await load();
    renderUserAnswer(monthId);
  } catch (error) {
    showToast(error.message);
  }
};

window.submitResponse = async (monthId, memberId, encoded) => {
  try {
    await api("/api/response", {
      method: "POST",
      body: JSON.stringify({ month_id: monthId, member_id: memberId, answers: JSON.parse(encoded) }),
    });
    showToast("回答を保存しました");
    await load();
    go("userSurvey");
  } catch (error) {
    showToast(error.message);
  }
};

function renderUserSchedule(monthId = null) {
  const published = publishedScheduleMonths();
  const month = monthId ? monthById(monthId) : defaultScheduleMonth();
  if (!month || !month.schedule_published) {
    shell(
      "シフト閲覧",
      `<section class="panel"><h2>シフトはまだ公開されていません</h2><p class="muted">更新をお待ちください。</p></section>`,
      `<button onclick="go('home')">戻る</button>`
    );
    return;
  }
  const currentIndex = published.findIndex((m) => m.id === month.id);
  const prevMonth = published[currentIndex - 1];
  const nextMonth = published[currentIndex + 1];
  const monthTabs = published
    .map((m) => `<button class="${m.id === month.id ? "primary" : ""}" onclick="renderUserSchedule(${m.id})">${monthLabel(m)}</button>`)
    .join("");
  shell(
    `${monthLabel(month)}シフト`,
    `
      <section class="panel">
        <div class="nav">${monthTabs}</div>
      </section>
      ${scheduleTable(month.id, false)}
    `,
    `<button onclick="go('home')">戻る</button><button ${prevMonth ? `onclick="renderUserSchedule(${prevMonth.id})"` : "disabled"}>前の公開月</button><button ${nextMonth ? `onclick="renderUserSchedule(${nextMonth.id})"` : "disabled"}>次の公開月</button>`
  );
}

function scheduleTable(monthId) {
  const dates = datesFor(monthId);
  if (dates.length === 0) return `<section class="panel">日付が設定されていません。</section>`;
  return state.venues
    .map(
      (v) => `
        <section class="panel">
          <h2>${v.name}</h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>日付</th><th>1</th><th>2</th><th>3</th></tr></thead>
              <tbody>
                ${dates
                  .map((d) => {
                    const cells = [1, 2, 3].map((slot) => {
                      const a = state.assignments.find((x) => x.month_id === Number(monthId) && x.date === d.date && x.venue_id === v.id && x.slot === slot);
                      const m = a ? memberById(a.member_id) : null;
                      return `<td>${m ? `${m.name}${drive(m)}` : ""}</td>`;
                    });
                    return `<tr><td>${dateLabel(d.date)}</td>${cells.join("")}</tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
        </section>
      `
    )
    .join("");
}

function renderAdminHome() {
  shell(
    "管理者ページ",
    `
      <section class="grid">
        <button onclick="go('adminMonths')">希望調査・シフト表の公開設定</button>
        <button onclick="go('adminResponses')">回答確認</button>
        <button onclick="go('adminBuilder')">シフト作成</button>
        <button onclick="go('adminHistoryInput')">過去シフト入力</button>
        <button onclick="go('adminMembers')">名簿管理</button>
        <button onclick="go('adminSync')">オンライン同期</button>
      </section>
    `,
    `<button onclick="logoutAdmin()">ログアウト</button>`
  );
}

function renderAdminSync() {
  const savedUrl = supabaseStatus?.url || "";
  const anonPlaceholder = supabaseStatus?.has_anon_key ? "・・・・・・" : "";
  const servicePlaceholder = supabaseStatus?.has_service_key ? "・・・・・・" : "";
  const configStatus = supabaseStatus
    ? `Project URL: ${savedUrl ? "保存済み" : "未設定"} / anon public key: ${supabaseStatus.has_anon_key ? "保存済み" : "未設定"} / service_role key: ${supabaseStatus.has_service_key ? "保存済み" : "未設定"}`
    : "保存済み設定を確認しています。";
  shell(
    "オンライン同期",
    `
      <section class="panel form">
        <h2>Supabase接続設定</h2>
        <p class="muted">Project URL、anon public key、service_role keyを入力して保存します。</p>
        <p class="muted" id="supabaseConfigStatus">${configStatus}</p>
        <label class="field-label">Project URL
          <input id="supabaseUrl" type="url" placeholder="https://xxxx.supabase.co" value="${savedUrl}">
        </label>
        <label class="field-label">anon public key
          <input id="supabaseAnonKey" type="password" autocomplete="off" placeholder="${anonPlaceholder}">
        </label>
        <label class="field-label">service_role key
          <input id="supabaseServiceKey" type="password" autocomplete="off" placeholder="${servicePlaceholder}">
        </label>
        <div class="row">
          <button class="primary" onclick="saveSupabaseConfig()">接続設定を保存</button>
          <button onclick="testSupabaseConnection()">接続テスト</button>
        </div>
      </section>
      <section class="panel">
        <h2>公開用ファイル</h2>
        <p class="muted">ユーザー公開ページ用の public フォルダを作成・更新します。</p>
        <button class="primary" onclick="buildPublicFiles()">公開用ファイルを作成</button>
      </section>
      <section class="panel">
        <h2>ローカルとオンラインDBを同期</h2>
        <p class="muted">Supabaseの設定が完了している場合に利用できます。</p>
        <div class="grid">
          <article class="panel">
            <h3>公開データを送る</h3>
            <p class="muted">名簿、会場、希望調査、シフト表をオンラインへ反映します。</p>
            <button class="primary" onclick="syncOnline('push')">送信する</button>
          </article>
          <article class="panel">
            <h3>回答を取り込む</h3>
            <p class="muted">オンラインに保存されたユーザー回答をローカルへ取り込みます。</p>
            <button class="primary" onclick="syncOnline('pull')">取り込む</button>
          </article>
          <article class="panel">
            <h3>まとめて同期</h3>
            <p class="muted">公開データの送信と回答の取り込みをまとめて行います。</p>
            <button class="primary" onclick="syncOnline('all')">同期する</button>
          </article>
        </div>
      </section>
    `,
    `<button onclick="go('adminHome')">戻る</button>`
  );
  refreshSupabaseStatus();
}

async function refreshSupabaseStatus() {
  try {
    supabaseStatus = await api("/api/supabase/status");
    const urlInput = document.querySelector("#supabaseUrl");
    const anonInput = document.querySelector("#supabaseAnonKey");
    const serviceInput = document.querySelector("#supabaseServiceKey");
    const status = document.querySelector("#supabaseConfigStatus");
    if (urlInput && !urlInput.value) urlInput.value = supabaseStatus.url || "";
    if (anonInput && supabaseStatus.has_anon_key) anonInput.placeholder = "・・・・・・";
    if (serviceInput && supabaseStatus.has_service_key) serviceInput.placeholder = "・・・・・・";
    if (status) {
      status.textContent = `Project URL: ${supabaseStatus.url ? "保存済み" : "未設定"} / anon public key: ${supabaseStatus.has_anon_key ? "保存済み" : "未設定"} / service_role key: ${supabaseStatus.has_service_key ? "保存済み" : "未設定"}`;
    }
  } catch (error) {
    const status = document.querySelector("#supabaseConfigStatus");
    if (status) status.textContent = "保存済み設定を確認できませんでした";
  }
}

async function testSupabaseConnection() {
  try {
    await api("/api/sync/test", { method: "POST", body: JSON.stringify({}) });
    showToast("Supabase接続を確認しました");
  } catch (error) {
    showToast(error.message);
  }
}

async function buildPublicFiles() {
  try {
    await api("/api/public/build", { method: "POST", body: JSON.stringify({}) });
    showToast("公開用ファイルを作成しました");
  } catch (error) {
    showToast(error.message);
  }
}

async function saveSupabaseConfig() {
  const payload = {
    url: document.querySelector("#supabaseUrl")?.value || "",
    anon_key: document.querySelector("#supabaseAnonKey")?.value || "",
    service_key: document.querySelector("#supabaseServiceKey")?.value || "",
  };
  try {
    await api("/api/supabase/config", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await refreshSupabaseStatus();
    showToast("Supabase接続設定を保存しました");
  } catch (error) {
    showToast(error.message);
  }
}

async function syncOnline(mode) {
  const labels = { push: "公開データを送信しました", pull: "回答を取り込みました", all: "同期しました" };
  const progressTitles = { push: "送信中", pull: "取り込み中", all: "同期中" };
  try {
    showSyncProgress(progressTitles[mode] || "同期中");
    await waitForPaint();
    await api(`/api/sync/${mode}`, { method: "POST", body: JSON.stringify({}) });
    setSyncProgress(94, "最新データを読み込んでいます。");
    state = await api("/api/bootstrap");
    await finishSyncProgress(labels[mode] || "同期しました");
    showToast(labels[mode] || "同期しました");
    renderAdminSync();
  } catch (error) {
    hideSyncProgress();
    showToast(error.message);
  }
}

function renderAdminMonths() {
  const nowYear = today.getFullYear();
  const nowMonth = today.getMonth() + 2 > 12 ? 1 : today.getMonth() + 2;
  const targetYear = today.getMonth() + 2 > 12 ? nowYear + 1 : nowYear;
  monthDateDraft = [];
  shell(
    "希望調査・シフト表の公開設定",
    `
      <section class="panel form">
        <h2>シフト情報の編集</h2>
        <div class="row">
          <label class="field-label">対象年<input id="monthYear" type="number" value="${targetYear}" min="2020" max="2100"></label>
          <label class="field-label">対象月<input id="monthMonth" type="number" value="${nowMonth}" min="1" max="12"></label>
          <label class="field-label">締め切り日<input id="deadline" type="date"></label>
          <label class="field-label">希望調査
            <select id="surveyStatus">
              <option value="draft">非公開</option>
              <option value="open">回答受付中</option>
              <option value="closed">締切</option>
            </select>
          </label>
          <label class="field-label">シフト表
            <select id="schedulePublished">
              <option value="0">非公開</option>
              <option value="1">公開</option>
            </select>
          </label>
        </div>
        <label>シフト日時</label>
        <div class="row">
          <input id="shiftDatePicker" type="date">
          <button type="button" onclick="addShiftDate()">追加</button>
        </div>
        <div id="shiftDateList" class="date-chip-list"></div>
        <button class="primary" onclick="saveMonth()">保存</button>
      </section>
      <section class="panel">
        <h2>登録済みシフト情報</h2>
        <div class="list">
          ${state.months
            .map(
              (m) => `
                <div class="member">
                  <div>${monthLabel(m)} <span class="badge">${statusText[m.survey_status]}</span> <span class="badge ${m.schedule_published ? "ok" : ""}">${m.schedule_published ? "シフト公開" : "シフト非公開"}</span></div>
                  <button onclick="fillMonth(${m.id})">編集</button>
                </div>
              `
            )
            .join("")}
        </div>
      </section>
    `,
    `<button onclick="go('adminHome')">戻る</button>`
  );
  renderShiftDateList();
}

window.fillMonth = (id) => {
  const m = monthById(id);
  document.querySelector("#monthYear").value = m.year;
  document.querySelector("#monthMonth").value = m.month;
  document.querySelector("#deadline").value = m.survey_deadline || "";
  document.querySelector("#surveyStatus").value = m.survey_status;
  document.querySelector("#schedulePublished").value = m.schedule_published ? "1" : "0";
  monthDateDraft = datesFor(id).map((d) => d.date);
  renderShiftDateList();
};

function renderShiftDateList() {
  const area = document.querySelector("#shiftDateList");
  if (!area) return;
  const dates = [...new Set(monthDateDraft)].sort();
  monthDateDraft = dates;
  area.innerHTML = dates.length
    ? dates.map((date) => `<span class="date-chip">${dateLabel(date)}<button type="button" onclick="removeShiftDate('${date}')">×</button></span>`).join("")
    : `<span class="muted">シフト日時がまだ選択されていません。</span>`;
}

window.addShiftDate = () => {
  const input = document.querySelector("#shiftDatePicker");
  if (!input.value) {
    showToast("シフト日時を選択してください");
    return;
  }
  monthDateDraft.push(input.value);
  input.value = "";
  renderShiftDateList();
};

window.removeShiftDate = (date) => {
  monthDateDraft = monthDateDraft.filter((d) => d !== date);
  renderShiftDateList();
};

window.saveMonth = async () => {
  const dates = [...new Set(monthDateDraft)].sort();
  await api("/api/month", {
    method: "POST",
    body: JSON.stringify({
      year: Number(document.querySelector("#monthYear").value),
      month: Number(document.querySelector("#monthMonth").value),
      survey_deadline: document.querySelector("#deadline").value,
      survey_status: document.querySelector("#surveyStatus").value,
      schedule_published: document.querySelector("#schedulePublished").value === "1",
      dates,
    }),
  });
  showToast("公開設定を保存しました");
  await load();
  go("adminMonths");
};

function renderAdminResponses() {
  const monthOptions = state.months.map((m) => `<option value="${m.id}">${monthLabel(m)}</option>`).join("");
  shell(
    "回答確認",
    `
      <section class="panel">
        <select id="responseMonth" onchange="renderResponseList()">${monthOptions}</select>
        <div id="responseList"></div>
      </section>
    `,
    `<button onclick="go('adminHome')">戻る</button>`
  );
  renderResponseList();
}

window.renderResponseList = () => {
  const monthId = Number(document.querySelector("#responseMonth")?.value);
  const area = document.querySelector("#responseList");
  if (!monthId || !area) return;
  const dates = datesFor(monthId);
  area.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>氏名</th><th>回答状況</th>${dates.map((d) => `<th>${dateLabel(d.date)}</th>`).join("")}</tr></thead>
        <tbody>
          ${state.members
            .map((m) => {
              const r = responseFor(monthId, m.id);
              const answers = {};
              if (r) responseDays(r.id).forEach((d) => (answers[d.date] = d.availability));
              return `<tr><td>${m.name}${drive(m)}</td><td>${r ? r.updated_at : "未回答"}</td>${dates.map((d) => `<td><span class="badge ${answers[d.date] || ""}">${availabilityText[answers[d.date]] || "-"}</span></td>`).join("")}</tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
};

function renderAdminBuilder() {
  const selectedMonthId = builderSelectedMonthId || state.months[0]?.id || "";
  const monthOptions = state.months.map((m) => `<option value="${m.id}" ${m.id === Number(selectedMonthId) ? "selected" : ""}>${monthLabel(m)}</option>`).join("");
  shell(
    "シフト作成",
    `
      <section class="panel row">
        <select id="buildMonth" onchange="renderBuilderDateOptions()">${monthOptions}</select>
        <select id="buildDate" onchange="renderBuilderWork()"></select>
      </section>
      <section id="builderWork"></section>
    `,
    `<button onclick="go('adminHome')">戻る</button>`
  );
  renderBuilderDateOptions();
}

window.renderBuilderDateOptions = () => {
  const monthId = Number(document.querySelector("#buildMonth").value);
  builderSelectedMonthId = monthId;
  const dates = datesFor(monthId);
  const selectedDate = builderSelectedDate && dates.some((d) => d.date === builderSelectedDate)
    ? builderSelectedDate
    : dates[0]?.date || "";
  builderSelectedDate = selectedDate;
  document.querySelector("#buildDate").innerHTML = dates.map((d) => `<option value="${d.date}" ${d.date === selectedDate ? "selected" : ""}>${dateLabel(d.date)}</option>`).join("");
  renderBuilderWork();
};

function candidatesFor(monthId, date) {
  return state.members
    .map((m) => {
      const r = responseFor(monthId, m.id);
      if (!r) return null;
      const day = responseDays(r.id).find((d) => d.date === date);
      if (!day || day.availability === "ng") return null;
      return { ...m, availability: day.availability };
    })
    .filter(Boolean);
}

function assignmentsForCurrentBuilder() {
  return Array.from(document.querySelectorAll("#builderWork select[data-venue]")).map((select) => ({
    venue_id: Number(select.dataset.venue),
    slot: Number(select.dataset.slot),
    member_id: select.value ? Number(select.value) : null,
  }));
}

function venueCountsForMember(memberId, monthId, date, previewAssignments = null) {
  const counts = Object.fromEntries(state.venues.map((venue) => [venue.id, 0]));
  state.assignments.forEach((assignment) => {
    const isEditingDate = assignment.month_id === Number(monthId) && assignment.date === date;
    if (!isEditingDate && assignment.member_id === Number(memberId)) {
      counts[assignment.venue_id] = (counts[assignment.venue_id] || 0) + 1;
    }
  });
  if (previewAssignments) {
    previewAssignments.forEach((assignment) => {
      if (assignment.member_id === Number(memberId)) {
        counts[assignment.venue_id] = (counts[assignment.venue_id] || 0) + 1;
      }
    });
  } else {
    state.assignments.forEach((assignment) => {
      const isEditingDate = assignment.month_id === Number(monthId) && assignment.date === date;
      if (isEditingDate && assignment.member_id === Number(memberId)) {
        counts[assignment.venue_id] = (counts[assignment.venue_id] || 0) + 1;
      }
    });
  }
  return counts;
}

function venueCountsHtml(memberId, monthId, date, previewAssignments = null) {
  const counts = venueCountsForMember(memberId, monthId, date, previewAssignments);
  return state.venues.map((venue) => `<span>${venue.name}：${counts[venue.id] || 0}</span>`).join("");
}

function monthlyAssignmentCount(memberId, monthId) {
  return state.assignments.filter((assignment) => (
    assignment.month_id === Number(monthId) && assignment.member_id === Number(memberId)
  )).length;
}

function memberOptionLabel(member, monthId) {
  const month = monthById(monthId);
  const monthText = month ? `${month.month}月` : "";
  return `${member.name}${drive(member)}（${monthText}${monthlyAssignmentCount(member.id, monthId)}回）`;
}

function builderCandidateListHtml(cands, monthId, date, previewAssignments = null) {
  if (cands.length === 0) return "候補者がいません";
  const month = monthById(monthId);
  return cands
    .map(
      (m) => `
        <div class="member candidate-member">
          <div>
            <div class="candidate-name">${m.name}${drive(m)} <span class="monthly-count">${month.month}月：${monthlyAssignmentCount(m.id, monthId)}回</span></div>
            <div class="venue-counts">${venueCountsHtml(m.id, monthId, date, previewAssignments)}</div>
          </div>
          <span class="badge ${m.availability}">${availabilityText[m.availability]}</span>
        </div>
      `
    )
    .join("");
}

window.renderBuilderWork = () => {
  const monthId = Number(document.querySelector("#buildMonth").value);
  const date = document.querySelector("#buildDate").value;
  builderSelectedMonthId = monthId;
  builderSelectedDate = date;
  const cands = candidatesFor(monthId, date);
  builderCandidates = cands;
  const options = `<option value="">未配置</option>${cands.map((m) => `<option value="${m.id}">${memberOptionLabel(m, monthId)} ${m.availability === "maybe" ? "△" : ""}</option>`).join("")}`;
  document.querySelector("#builderWork").innerHTML = `
    <div class="schedule-grid">
      <aside class="panel">
        <h2>${dateLabel(date)}の候補者</h2>
        <div id="builderCandidateList" class="list">
          ${builderCandidateListHtml(cands, monthId, date)}
        </div>
      </aside>
      <section class="panel">
        <h2>配置編集</h2>
        <div class="slots">
          ${state.venues
            .map(
              (v) => `
                <div class="slot-box">
                  <h3>${v.name}</h3>
                  ${[1, 2, 3]
                    .map((slot) => {
                      const a = state.assignments.find((x) => x.month_id === monthId && x.date === date && x.venue_id === v.id && x.slot === slot);
                      return `<label class="slot-row"><span>${slot}</span><select data-venue="${v.id}" data-slot="${slot}" onchange="refreshBuilderSelectOptions()">${options}</select></label>`;
                    })
                    .join("")}
                </div>
              `
            )
            .join("")}
        </div>
        <div class="actions"><button class="primary" onclick="saveAssignments()">保存する</button></div>
        <div id="assignmentConfirm"></div>
      </section>
    </div>
  `;
  document.querySelectorAll("#builderWork select[data-venue]").forEach((select) => {
    const a = state.assignments.find((x) => x.month_id === monthId && x.date === date && x.venue_id === Number(select.dataset.venue) && x.slot === Number(select.dataset.slot));
    select.value = a?.member_id || "";
  });
  refreshBuilderSelectOptions();
};

window.refreshBuilderSelectOptions = () => {
  const selects = Array.from(document.querySelectorAll("#builderWork select[data-venue]"));
  const selectedValues = selects.map((select) => select.value).filter(Boolean);
  selects.forEach((select) => {
    const currentValue = select.value;
    const selectedElsewhere = new Set(selectedValues.filter((value) => value !== currentValue));
    select.innerHTML = `<option value="">未配置</option>${builderCandidates
      .filter((member) => !selectedElsewhere.has(String(member.id)))
      .map((member) => `<option value="${member.id}">${memberOptionLabel(member, builderSelectedMonthId)} ${member.availability === "maybe" ? "△" : ""}</option>`)
      .join("")}`;
    select.value = currentValue;
  });
  const confirmArea = document.querySelector("#assignmentConfirm");
  if (confirmArea) confirmArea.innerHTML = "";
  renderBuilderCandidateCounts();
};

function renderBuilderCandidateCounts(previewAssignments = null) {
  const area = document.querySelector("#builderCandidateList");
  const monthId = Number(document.querySelector("#buildMonth")?.value);
  const date = document.querySelector("#buildDate")?.value;
  if (!area || !monthId || !date) return;
  area.innerHTML = builderCandidateListHtml(builderCandidates, monthId, date, previewAssignments);
}

window.confirmAssignments = () => {
  const chosen = Array.from(document.querySelectorAll("#builderWork select[data-venue]"));
  const selectedMemberIds = chosen.map((s) => s.value).filter(Boolean);
  if (new Set(selectedMemberIds).size !== selectedMemberIds.length) {
    showToast("同じメンバーが複数枠に選択されています");
    return;
  }
  const html = chosen
    .map((s) => {
      const venue = state.venues.find((v) => v.id === Number(s.dataset.venue));
      const member = memberById(s.value);
      return `<div>${venue.name} メンバー${s.dataset.slot}：${member ? `${member.name}${drive(member)}` : "未配置"}</div>`;
    })
    .join("");
  document.querySelector("#assignmentConfirm").innerHTML = `
    <div class="panel">
      <h3>確認</h3>
      ${html}
      <button class="primary" onclick="saveAssignments()">保存する</button>
    </div>
  `;
};

window.saveAssignments = async () => {
  const monthId = Number(document.querySelector("#buildMonth").value);
  const date = document.querySelector("#buildDate").value;
  const assignments = assignmentsForCurrentBuilder();
  const selectedMemberIds = assignments.map((assignment) => assignment.member_id).filter(Boolean);
  if (new Set(selectedMemberIds).size !== selectedMemberIds.length) {
    showToast("同じメンバーが複数枠に選択されています");
    return;
  }
  await api("/api/assignments", { method: "POST", body: JSON.stringify({ month_id: monthId, date, assignments }) });
  showToast("シフトを保存しました");
  builderSelectedMonthId = monthId;
  builderSelectedDate = date;
  await load();
  go("adminBuilder");
};

function renderAdminHistoryInput() {
  shell(
    "過去シフト入力",
    `
      <section class="panel form">
        <h2>過去シフト情報</h2>
        <div class="row">
          <label class="field-label">対象年<input id="historyYear" type="number" value="${today.getFullYear()}" min="2020" max="2100" onchange="refreshHistorySelectOptions()"></label>
          <label class="field-label">対象月<input id="historyMonth" type="number" value="${today.getMonth() + 1}" min="1" max="12" onchange="refreshHistorySelectOptions()"></label>
          <label class="field-label">シフト日<input id="historyDate" type="date"></label>
        </div>
      </section>
      <section class="panel">
        <h2>配置編集</h2>
        <div class="slots">
          ${state.venues
            .map(
              (venue) => `
                <div class="slot-box">
                  <h3>${venue.name}</h3>
                  ${[1, 2, 3]
                    .map((slot) => `<label class="slot-row"><span>${slot}</span><select data-history-venue="${venue.id}" data-history-slot="${slot}" onchange="refreshHistorySelectOptions()"></select></label>`)
                    .join("")}
                </div>
              `
            )
            .join("")}
        </div>
        <div class="actions"><button class="primary" onclick="saveHistoryAssignments()">保存する</button></div>
      </section>
    `,
    `<button onclick="go('adminHome')">戻る</button>`
  );
  refreshHistorySelectOptions();
}

window.refreshHistorySelectOptions = () => {
  const selects = Array.from(document.querySelectorAll("select[data-history-venue]"));
  const year = Number(document.querySelector("#historyYear")?.value);
  const month = Number(document.querySelector("#historyMonth")?.value);
  const existingMonth = state.months.find((m) => m.year === year && m.month === month);
  const monthId = existingMonth?.id;
  const selectedValues = selects.map((select) => select.value).filter(Boolean);
  selects.forEach((select) => {
    const currentValue = select.value;
    const selectedElsewhere = new Set(selectedValues.filter((value) => value !== currentValue));
    select.innerHTML = `<option value="">未配置</option>${state.members
      .filter((member) => !selectedElsewhere.has(String(member.id)))
      .map((member) => `<option value="${member.id}">${monthId ? memberOptionLabel(member, monthId) : `${member.name}${drive(member)}（${month || ""}月0回）`}</option>`)
      .join("")}`;
    select.value = currentValue;
  });
};

window.saveHistoryAssignments = async () => {
  const year = Number(document.querySelector("#historyYear").value);
  const month = Number(document.querySelector("#historyMonth").value);
  const date = document.querySelector("#historyDate").value;
  if (!year || !month || !date) {
    showToast("対象年・対象月・シフト日を入力してください");
    return;
  }
  const assignments = Array.from(document.querySelectorAll("select[data-history-venue]")).map((select) => ({
    venue_id: Number(select.dataset.historyVenue),
    slot: Number(select.dataset.historySlot),
    member_id: select.value ? Number(select.value) : null,
  }));
  const selectedMemberIds = assignments.map((assignment) => assignment.member_id).filter(Boolean);
  if (new Set(selectedMemberIds).size !== selectedMemberIds.length) {
    showToast("同じメンバーが複数枠に選択されています");
    return;
  }
  const existingMonth = state.months.find((m) => m.year === year && m.month === month);
  const existingDates = existingMonth ? datesFor(existingMonth.id).map((d) => d.date) : [];
  const monthResult = await api("/api/month", {
    method: "POST",
    body: JSON.stringify({
      year,
      month,
      survey_status: existingMonth?.survey_status || "draft",
      survey_deadline: existingMonth?.survey_deadline || "",
      schedule_published: existingMonth ? Boolean(existingMonth.schedule_published) : false,
      dates: [...new Set([...existingDates, date])].sort(),
    }),
  });
  await api("/api/assignments", {
    method: "POST",
    body: JSON.stringify({ month_id: monthResult.month_id, date, assignments }),
  });
  showToast("過去シフトを保存しました");
  await load();
  go("adminHistoryInput");
};

function renderAdminMembers() {
  shell(
    "名簿管理",
    `
      <section class="panel form">
        <h2>メンバー登録</h2>
        <div class="row">
          <input id="newMemberName" placeholder="氏名">
          <label><input id="newMemberDrive" type="checkbox"> 車出し可能</label>
          <button class="primary" onclick="addMember()">追加</button>
        </div>
      </section>
      <section class="panel">
        <h2>メンバー一覧</h2>
        <div class="list">
          ${state.members
            .map(
              (m) => `
                <div class="member">
                  <input id="member-name-${m.id}" value="${m.name}">
                  <label><input id="member-drive-${m.id}" type="checkbox" ${m.can_drive ? "checked" : ""}> 車出し可能</label>
                  <button onclick="updateMember(${m.id})">保存</button>
                  <button class="danger" onclick="deleteMember(${m.id})">削除</button>
                </div>
              `
            )
            .join("")}
        </div>
      </section>
    `,
    `<button onclick="go('adminHome')">戻る</button>`
  );
}

window.addMember = async () => {
  await api("/api/member", {
    method: "POST",
    body: JSON.stringify({
      name: document.querySelector("#newMemberName").value,
      can_drive: document.querySelector("#newMemberDrive").checked,
    }),
  });
  showToast("メンバーを追加しました");
  await load();
  go("adminMembers");
};

window.updateMember = async (id) => {
  await api("/api/member/update", {
    method: "POST",
    body: JSON.stringify({
      id,
      name: document.querySelector(`#member-name-${id}`).value,
      can_drive: document.querySelector(`#member-drive-${id}`).checked,
    }),
  });
  showToast("メンバーを更新しました");
  await load();
  go("adminMembers");
};

window.deleteMember = async (id) => {
  if (!confirm("このメンバーを削除しますか？")) return;
  await api("/api/member/delete", { method: "POST", body: JSON.stringify({ id }) });
  showToast("メンバーを削除しました");
  await load();
  go("adminMembers");
};

function render() {
  if (onlineMode && isAdminRoute(route)) {
    return shell(
      "管理者ページ",
      `<section class="panel"><h2>管理者ページはローカルアプリで開いてください</h2></section>`,
      `<button onclick="go('home')">戻る</button>`
    );
  }
  if (isAdminRoute(route) && !adminToken) return renderAdminLogin();
  if (route === "home") return renderHome();
  if (route === "userSurvey") return renderUserSurvey();
  if (route.startsWith("userAnswer:")) return renderUserAnswer(route.split(":")[1]);
  if (route === "userSchedule") return renderUserSchedule();
  if (route === "adminLogin") return renderAdminLogin();
  if (route === "adminHome") return renderAdminHome();
  if (route === "adminMonths") return renderAdminMonths();
  if (route === "adminResponses") return renderAdminResponses();
  if (route === "adminBuilder") return renderAdminBuilder();
  if (route === "adminHistoryInput") return renderAdminHistoryInput();
  if (route === "adminMembers") return renderAdminMembers();
  if (route === "adminSync") return renderAdminSync();
  renderHome();
}

load().catch((error) => {
  app.innerHTML = `<main class="shell"><section class="panel"><h1>起動エラー</h1><p>${error.message}</p></section></main>`;
});
