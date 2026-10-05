"use strict";

const BACKUP_FORMAT = "KH_VEHICLE_INVENTORY_BACKUP";
const BACKUP_VERSION = 2;
const BACKUP_NULL = "__KH_NULL__";
const BACKUP_JSON = "__KH_JSON__";
const BACKUP_STRING = "__KH_STRING__";
const BACKUP_ENCRYPTED = "__KH_AES256GCM__";
const BACKUP_KDF = "PBKDF2-SHA256/AES-256-GCM/310000";
const BACKUP_PASSWORDS_OMITTED = "NOT_INCLUDED";
const BACKUP_KDF_ITERATIONS = 310000;
const BACKUP_BATCH_SIZE = 200;
const BACKUP_FOLDER_GROUPS = {
  "Settings": ["locations","roles","permissions","role_permissions","company_settings","system_settings","import_configuration"],
  "Inventory": ["vehicles"],
  "Operations": ["deliveries","gate_movements","vehicle_timeline","import_batches"],
  "Administration": ["audit_logs","user_profiles"]
};
const BACKUP_TABLES = [
  {name:"locations", key:["id"]},
  {name:"roles", key:["id"]},
  {name:"permissions", key:["id"]},
  {name:"role_permissions", key:["role_id","permission_id"]},
  {name:"company_settings", key:["id"]},
  {name:"system_settings", key:["id"]},
  {name:"import_configuration", key:["id"]},
  {name:"vehicles", key:["id"]},
  {name:"deliveries", key:["id"]},
  {name:"gate_movements", key:["id"]},
  {name:"vehicle_timeline", key:["id"]},
  {name:"import_batches", key:["id"]},
  {name:"audit_logs", key:["id"]},
  {name:"user_profiles", key:["id"]}
];
let RESTORE_PREVIEW = null;
let DRIVE_RESTORE_FILE = null;
let DRIVE_RESTORE_PREVIEW = null;
let DRIVE_ACCESS_TOKEN = null;
let DRIVE_TOKEN_EXPIRES_AT = 0;
let GOOGLE_IDENTITY_PROMISE = null;
let DRIVE_TOKEN_CLIENT = null;
let DRIVE_TOKEN_PENDING = null;
let DRIVE_BACKUP_FOLDERS = new Map();
const DRIVE_API_ROOT = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_ROOT = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_BACKUP_ROOT_NAME = "Kothari Hyundai Backups";
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DRIVE_AUTO_BACKUP_KEY = "kh-drive-auto-backup-v2";
const DRIVE_AUTO_BACKUP_DATE_KEY = "kh-drive-auto-backup-last-success";
let DRIVE_BACKUP_RUNNING = false;

function renderBackupRestore(){
  if(!state.isAdmin){ renderDenied(); return; }
  $("content").innerHTML = `<div class="panel backup-panel">
    <div class="panel-head"><h3>Backup & Restore</h3></div>
    <p class="form-help">Backup ZIP मध्ये application data आणि settings असतील. Profile display-passwords, photos, PDFs, gate-pass files आणि Supabase login passwords backup मध्ये नसतील. ZIP password-protected नाही; Google Drive मधील access private ठेवा.</p>
    <section class="backup-section">
      <h4>Google Drive backup</h4>
      <p class="form-help">1. Download Backup ZIP. 2. ZIP तयार झाल्यावर Open Google Drive क्लिक करा. 3. Google Drive मध्ये ZIP manually upload करा.</p>
      <div class="backup-actions"><button class="primary-btn" type="button" id="backupZipDownload">⬇ Download Backup ZIP</button><a class="secondary-btn" id="openGoogleDrive" href="https://drive.google.com/drive/my-drive" target="_blank" rel="noopener">↗ Open Google Drive</a></div>
      <div id="backupZipMessage" class="message" aria-live="polite"></div>
    </section>
    <section class="backup-section">
      <h4>Restore backup</h4>
      <p class="form-help">Select a backup ZIP or legacy Excel workbook. ZIP files include a restorable workbook. Restore adds missing rows and updates matching rows; it never deletes existing records.</p>
      <label for="backupFile">Select backup (.zip or .xlsx)</label><input id="backupFile" type="file" accept=".zip,.xlsx,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
      <label class="backup-label" for="backupRestorePass">Legacy Excel backup passphrase (only if requested)</label><input id="backupRestorePass" type="password" autocomplete="current-password">
      <div class="backup-actions"><button class="secondary-btn" type="button" id="backupPreviewButton">Validate Backup</button><button class="primary-btn" type="button" id="backupRestore" disabled>Restore Backup</button></div>
      <div id="backupMessage" class="message" aria-live="polite"></div><div id="backupPreview"></div>
    </section></div>`;
  $("backupZipDownload").addEventListener("click", createZipBackup);
  $("backupPreviewButton").addEventListener("click", previewDataBackup);
  $("backupRestore").addEventListener("click", restoreDataBackup);
  $("backupFile").addEventListener("change", () => {
    RESTORE_PREVIEW = null;
    $("backupRestore").disabled = true;
    $("backupRestorePass").value = "";
    $("backupPreview").innerHTML = "";
    $("backupMessage").textContent = "";
    $("backupMessage").className = "message";
  });
  $("backupRestorePass").addEventListener("input", () => {
    RESTORE_PREVIEW = null;
    $("backupRestore").disabled = true;
    $("backupPreview").replaceChildren();
  });
}
function backupZipStatus(message, type = ""){
  const el = $("backupZipMessage");
  if(!el) return;
  el.textContent = message;
  el.className = "message" + (type ? " " + type : "");
}
async function createZipBackup(){
  const btn = $("backupZipDownload");
  if(!state.isAdmin) return toast("Only Admin can create backups.","error");
  if(!window.XLSX) return backupZipStatus("Excel library did not load. Check your internet connection.", "error");
  if(!window.JSZip) return backupZipStatus("ZIP library did not load. Check your internet connection and reload.", "error");
  btn.disabled = true;
  try {
    backupZipStatus("Collecting application data…");
    const {wb, contents} = await collectDriveBackupContents(btn);
    const date = todayLocal();
    const fileName = `kothari-hyundai-backup-${date}.xlsx`;
    const zip = new window.JSZip();
    zip.file(fileName, backupWorkbookBytes(wb));
    zip.file("README.txt", [
      "Kothari Hyundai Vehicle Inventory Backup",
      `Backup date: ${date}`,
      "",
      "Restore: in the website open Backup & Restore, select this ZIP under Restore Backup, validate it, and restore.",
      "Passwords, profile display-passwords, photos, PDFs, and gate-pass files are not included."
    ].join("\r\n"));
    backupZipStatus("Creating dated ZIP file…");
    const blob = await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:6}}, metadata => {
      backupZipStatus(`Creating Backup ZIP… ${Math.floor(metadata.percent)}%`);
    });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url;
    link.download = `kothari-hyundai-backup-${date}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    const records = contents.reduce((total, item) => total + item.rows.length, 0);
    logAudit("CREATE_BACKUP","administration","backup",null,{tables:contents.length,records,zip:true});
    backupZipStatus(`Backup ZIP downloaded: kothari-hyundai-backup-${date}.zip. Open Google Drive and upload this ZIP.`, "success");
  } catch(error){
    const message = "Backup ZIP failed: " + (error.message || error);
    backupZipStatus(message, "error");
    toast(message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Download Backup ZIP";
  }
}

function backupStatus(message, type = ""){
  const el = $("backupMessage");
  if(!el) return;
  el.textContent = message;
  el.className = "message" + (type ? " " + type : "");
}
function backupFolderStatus(message, type = ""){
  const el = $("backupFolderMessage");
  if(!el) return;
  el.textContent = message;
  el.className = "message" + (type ? " " + type : "");
}
function backupDriveStatus(message, type = ""){
  const el = $("driveBackupMessage");
  if(!el) return;
  el.textContent = message;
  el.className = "message" + (type ? " " + type : "");
}
function driveRestoreStatus(message, type = ""){
  const el = $("driveRestoreMessage");
  if(!el) return;
  el.textContent = message;
  el.className = "message" + (type ? " " + type : "");
}
function backupDriveConfig(){
  const clientId = window.APP_CONFIG?.googleDriveClientId;
  if(typeof clientId !== "string" || !clientId.trim()) {
    throw new Error("Google Drive is not configured. Add your Google OAuth Web Client ID to APP_CONFIG.googleDriveClientId in js/config.js, enable the Google Drive API and Gmail API, and add this website's origin to the OAuth client's authorized JavaScript origins.");
  }
  return clientId.trim();
}
function loadGoogleIdentityServices(){
  if(window.google?.accounts?.oauth2) return Promise.resolve();
  if(GOOGLE_IDENTITY_PROMISE) return GOOGLE_IDENTITY_PROMISE;
  GOOGLE_IDENTITY_PROMISE = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => window.google?.accounts?.oauth2 ? resolve() : reject(new Error("Google Identity Services did not initialize."));
    script.onerror = () => reject(new Error("Could not load Google sign-in. Check your internet connection and content security policy."));
    document.head.appendChild(script);
  }).catch(error => {
    GOOGLE_IDENTITY_PROMISE = null;
    throw error;
  });
  return GOOGLE_IDENTITY_PROMISE;
}
async function getDriveAccessToken(){
  const clientId = backupDriveConfig();
  await loadGoogleIdentityServices();
  if(DRIVE_ACCESS_TOKEN && DRIVE_TOKEN_EXPIRES_AT > Date.now() + 60000) return DRIVE_ACCESS_TOKEN;
  DRIVE_ACCESS_TOKEN = null;
  if(DRIVE_TOKEN_PENDING) return DRIVE_TOKEN_PENDING.promise;
  let resolveToken, rejectToken;
  const promise = new Promise((resolve,reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });
  DRIVE_TOKEN_PENDING = {resolve:resolveToken,reject:rejectToken,promise};
  try {
    if(!DRIVE_TOKEN_CLIENT){
      DRIVE_TOKEN_CLIENT = window.google.accounts.oauth2.initTokenClient({
        client_id:clientId,
        scope:"https://www.googleapis.com/auth/drive.file",
        callback:response => {
          const pending = DRIVE_TOKEN_PENDING;
          DRIVE_TOKEN_PENDING = null;
          if(!pending) return;
          if(response.error || !response.access_token){
            DRIVE_ACCESS_TOKEN = null;
            DRIVE_TOKEN_EXPIRES_AT = 0;
            pending.reject(new Error(response.error_description || response.error || "Google authorization did not return an access token."));
            return;
          }
          DRIVE_ACCESS_TOKEN = response.access_token;
          DRIVE_TOKEN_EXPIRES_AT = Date.now() + Math.max(0, Number(response.expires_in) || 3600) * 1000;
          pending.resolve(DRIVE_ACCESS_TOKEN);
        },
        error_callback:error => {
          const pending = DRIVE_TOKEN_PENDING;
          DRIVE_TOKEN_PENDING = null;
          if(pending) pending.reject(new Error(error.message || "Google sign-in was cancelled or blocked."));
        }
      });
    }
    const loginHint = window.APP_CONFIG?.googleDriveAccountEmail || window.APP_CONFIG?.usernameEmailMap?.admin;
    try { DRIVE_TOKEN_CLIENT.requestAccessToken({prompt:"", ...(loginHint ? {login_hint:loginHint} : {})}); }
    catch(error){ DRIVE_TOKEN_PENDING = null; rejectToken(error); }
  } catch(error){
    DRIVE_TOKEN_PENDING = null;
    rejectToken(error);
  }
  return promise;
}
async function driveApi(path, options = {}){
  const token = await getDriveAccessToken();
  const response = await fetch(`${DRIVE_API_ROOT}${path}`, {
    ...options,
    headers:{Authorization:`Bearer ${token}`, ...(options.headers || {})}
  });
  if(response.status === 401){ DRIVE_ACCESS_TOKEN = null; DRIVE_TOKEN_EXPIRES_AT = 0; }
  if(!response.ok){
    let detail = "";
    try {
      const body = await response.json();
      detail = body.error?.message || "";
    } catch {}
    throw new Error(`Google Drive request failed (${response.status})${detail ? `: ${detail}` : ""}${response.status === 401 ? ". Retry and approve Drive access." : ""}`);
  }
  return response.status === 204 ? null : response.json();
}
function driveEscapeQuery(value){
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}
async function findDriveFolder(name, parentId = null){
  const clauses = [`name = '${driveEscapeQuery(name)}'`, `mimeType = '${DRIVE_FOLDER_MIME}'`, "trashed = false"];
  if(parentId) clauses.push(`'${driveEscapeQuery(parentId)}' in parents`);
  const query = encodeURIComponent(clauses.join(" and "));
  const result = await driveApi(`/files?q=${query}&spaces=drive&fields=files(id,name,mimeType,modifiedTime)&pageSize=100`);
  return result.files?.[0] || null;
}
async function createDriveFolder(name, parentId){
  const folder = await driveApi("/files?fields=id,name,mimeType,parents", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({name,mimeType:DRIVE_FOLDER_MIME,parents:[parentId]})
  });
  if(!folder?.id) throw new Error(`Google Drive did not create folder ${name}.`);
  return folder;
}
async function getOrCreateDriveFolder(name, parentId){
  return await findDriveFolder(name, parentId) || await createDriveFolder(name, parentId);
}
async function getDriveBackupRoot(create = false){
  let folder = await findDriveFolder(DRIVE_BACKUP_ROOT_NAME);
  if(!folder && create) folder = await createDriveFolder(DRIVE_BACKUP_ROOT_NAME, "root");
  return folder;
}
async function uploadDriveWorkbook(parentId, name, workbook){
  const query = new URLSearchParams({
    q:`name = '${driveEscapeQuery(name)}' and '${driveEscapeQuery(parentId)}' in parents and trashed = false`,
    spaces:"drive",
    fields:"files(id,name)",
    pageSize:"100"
  });
  const found = await driveApi(`/files?${query.toString()}`);
  const existing = found.files?.[0];
  const boundary = `kh_backup_${backupBase64(backupRandom(12)).replace(/[+/=]/g,"")}`;
  const metadata = JSON.stringify({name,mimeType:XLSX_MIME,...(existing ? {} : {parents:[parentId]})});
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${XLSX_MIME}\r\n\r\n`,
    backupWorkbookBytes(workbook),
    `\r\n--${boundary}--`
  ]);
  const path = existing
    ? `/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id,name`
    : `/files?uploadType=multipart&fields=id,name`;
  const result = await driveApiUpload(path, boundary, body, existing ? "PATCH" : "POST");
  if(!result?.id) throw new Error(`Google Drive did not save ${name}.`);
  return result;
}
async function driveApiUpload(path, boundary, body, method = "POST"){
  const token = await getDriveAccessToken();
  const response = await fetch(`${DRIVE_UPLOAD_ROOT}${path}`, {
    method,
    headers:{Authorization:`Bearer ${token}`, "Content-Type":`multipart/related; boundary=${boundary}`},
    body
  });
  if(response.status === 401){ DRIVE_ACCESS_TOKEN = null; DRIVE_TOKEN_EXPIRES_AT = 0; }
  if(!response.ok){
    let detail = "";
    try { detail = (await response.json()).error?.message || ""; } catch {}
    throw new Error(`Google Drive upload failed (${response.status})${detail ? `: ${detail}` : ""}${response.status === 401 ? ". Retry and approve Drive access." : ""}`);
  }
  return response.json();
}
async function emailDriveBackupLink(folder, backupDate){
  const recipient = String(window.APP_CONFIG?.backupNotificationEmail || window.APP_CONFIG?.usernameEmailMap?.admin || "").trim();
  if(!recipient) throw new Error("Admin backup notification email is not configured in js/config.js.");
  const subject = `Kothari Hyundai daily backup - ${backupDate}`;
  const link = `https://drive.google.com/drive/folders/${encodeURIComponent(folder.id)}`;
  const message = [
    `To: ${recipient}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    `The Kothari Hyundai data backup for ${backupDate} is ready in Google Drive.`,
    "",
    `Open backup folder: ${link}`,
    "",
    "This email contains a link only; it does not include the backup as an attachment."
  ].join("\r\n");
  const raw = backupBase64(new TextEncoder().encode(message)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const token = await getDriveAccessToken();
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method:"POST",
    headers:{"Content-Type":"application/json",Authorization:"Bearer " + token},
    body:JSON.stringify({raw})
  });
  if(!response.ok){
    let detail = "";
    try { detail = (await response.json()).error?.message || ""; } catch {}
    throw new Error(`Admin backup email failed (${response.status})${detail ? `: ${detail}` : ""}. Approve the Gmail permission and enable the Gmail API.`);
  }
}
async function listDriveChildren(parentId, mimeType = null){
  const all = [];
  let pageToken = "";
  do {
    const clauses = [`'${driveEscapeQuery(parentId)}' in parents`, "trashed = false"];
    if(mimeType) clauses.push(`mimeType = '${mimeType}'`);
    const params = new URLSearchParams({q:clauses.join(" and "),spaces:"drive",fields:"nextPageToken,files(id,name,mimeType,modifiedTime)",pageSize:"100",orderBy:"modifiedTime desc"});
    if(pageToken) params.set("pageToken", pageToken);
    const result = await driveApi(`/files?${params.toString()}`);
    all.push(...(result.files || []));
    pageToken = result.nextPageToken || "";
  } while(pageToken);
  return all;
}
async function downloadDriveWorkbook(fileId){
  const token = await getDriveAccessToken();
  const response = await fetch(`${DRIVE_API_ROOT}/files/${encodeURIComponent(fileId)}?alt=media`, {headers:{Authorization:`Bearer ${token}`}});
  if(response.status === 401){ DRIVE_ACCESS_TOKEN = null; DRIVE_TOKEN_EXPIRES_AT = 0; }
  if(!response.ok) throw new Error(`Could not download backup from Google Drive (${response.status}).`);
  return response.blob();
}
function backupCrypto(){
  if(!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) throw new Error("Secure encryption is unavailable in this browser. Open the app over HTTPS and try again.");
  return globalThis.crypto;
}
function backupBase64(bytes){
  let binary = "";
  for(let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function backupUnbase64(value){
  const binary = atob(value);
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}
function backupRandom(length){
  const bytes = new Uint8Array(length);
  backupCrypto().getRandomValues(bytes);
  return bytes;
}
async function deriveBackupKey(passphrase, salt){
  if(typeof passphrase !== "string" || passphrase.length < 12) throw new Error("Use a backup passphrase of at least 12 characters.");
  const cryptoApi = backupCrypto(), material = await cryptoApi.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return cryptoApi.subtle.deriveKey({name:"PBKDF2", salt, iterations:BACKUP_KDF_ITERATIONS, hash:"SHA-256"}, material, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"]);
}
async function encryptProfilePassword(value, profileId, key){
  if(value === null || value === undefined || value === "") return BACKUP_NULL;
  const cryptoApi = backupCrypto(), iv = backupRandom(12), additionalData = new TextEncoder().encode(`user_profiles:${profileId}:password_display`);
  const ciphertext = new Uint8Array(await cryptoApi.subtle.encrypt({name:"AES-GCM", iv, additionalData}, key, new TextEncoder().encode(String(value))));
  const packed = new Uint8Array(iv.length + ciphertext.length); packed.set(iv); packed.set(ciphertext, iv.length);
  return BACKUP_ENCRYPTED + backupBase64(packed);
}
async function decryptProfilePassword(value, profileId, key){
  if(value === BACKUP_NULL) return null;
  if(typeof value !== "string" || !value.startsWith(BACKUP_ENCRYPTED)) throw new Error(`User profile ${profileId} contains an unencrypted password field. Create a new backup with this version.`);
  const packed = backupUnbase64(value.slice(BACKUP_ENCRYPTED.length));
  if(packed.length <= 28) throw new Error(`User profile ${profileId} has an invalid encrypted password field.`);
  const cryptoApi = backupCrypto(), iv = packed.slice(0,12), ciphertext = packed.slice(12);
  const additionalData = new TextEncoder().encode(`user_profiles:${profileId}:password_display`);
  try {
    const clear = await cryptoApi.subtle.decrypt({name:"AES-GCM", iv, additionalData}, key, ciphertext);
    return new TextDecoder("utf-8", {fatal:true}).decode(clear);
  } catch { throw new Error("Could not decrypt profile password fields. Check the passphrase and make sure the workbook was not modified."); }
}
function backupSafeRow(table, row){
  const omit = new Set(table.omit || []);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !omit.has(key)));
}
function backupEncode(value){
  if(value === null || value === undefined) return BACKUP_NULL;
  if(typeof value === "string" && value.startsWith("__KH_")) return BACKUP_STRING + value;
  if(typeof value === "object") return BACKUP_JSON + JSON.stringify(value);
  return value;
}
function backupDecode(value){
  if(value === BACKUP_NULL) return null;
  if(typeof value !== "string") return value;
  if(value.startsWith(BACKUP_STRING)) return value.slice(BACKUP_STRING.length);
  if(value.startsWith(BACKUP_JSON)){
    try { return JSON.parse(value.slice(BACKUP_JSON.length)); }
    catch { throw new Error("Backup contains invalid JSON data."); }
  }
  return value;
}
async function fetchBackupTable(table){
  const rows = [];
  for(let from = 0; ; from += 1000){
    const {data, error} = await state.supabase.from(table.name).select("*").order(table.key[0]).range(from, from + 999);
    if(error) throw new Error(`${table.name}: ${error.message}`);
    const batch = data || [];
    rows.push(...batch.map(row => backupSafeRow(table, row)));
    if(batch.length < 1000) return rows;
    if(rows.length >= 1048575) throw new Error(`${table.name} exceeds Excel's per-sheet row limit.`);
  }
}
async function collectBackupContents(btn, encryptionKey, salt){
  const contents = [];
  const manifest = [
    ["Kothari Hyundai Backup", BACKUP_FORMAT],
    ["Version", BACKUP_VERSION],
    ["Created at", new Date().toISOString()],
    ["Table", "Record count"],
    ["Password field encryption", BACKUP_KDF],
    ["Encryption salt", backupBase64(salt)]
  ];
  for(let i = 0; i < BACKUP_TABLES.length; i++){
    const table = BACKUP_TABLES[i];
    btn.textContent = `Reading ${i + 1}/${BACKUP_TABLES.length}: ${table.name}…`;
    const rows = await fetchBackupTable(table);
    manifest.push([table.name, rows.length]);
    contents.push({table, rows});
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(manifest), "Backup Info");
  for(const {table, rows} of contents){
    const sheetRows = [];
    for(const row of rows){
      const output = {};
      for(const [key,value] of Object.entries(row)){
        output[key] = table.name === "user_profiles" && key === "password_display"
          ? encryptionKey ? await encryptProfilePassword(value, row.id, encryptionKey) : backupEncode(value)
          : backupEncode(value);
      }
      sheetRows.push(output);
    }
    const ws = sheetRows.length ? XLSX.utils.json_to_sheet(sheetRows) : XLSX.utils.aoa_to_sheet([["No records"]]);
    XLSX.utils.book_append_sheet(wb, ws, table.name);
  }
  return {wb, contents};
}
async function collectDriveBackupContents(btn){
  const manifest = [
    ["Kothari Hyundai Backup", BACKUP_FORMAT],
    ["Version", BACKUP_VERSION],
    ["Created at", new Date().toISOString()],
    ["Table", "Record count"],
    ["Password field encryption", BACKUP_PASSWORDS_OMITTED],
    ["Encryption salt", ""]
  ];
  const contents = [];
  for(let i = 0; i < BACKUP_TABLES.length; i++){
    const table = BACKUP_TABLES[i];
    if(btn) btn.textContent = `Reading ${i + 1}/${BACKUP_TABLES.length}: ${table.name}…`;
    let rows = await fetchBackupTable(table);
    if(table.name === "user_profiles") rows = rows.map(({password_display,...row}) => row);
    manifest.push([table.name, rows.length]);
    contents.push({table, rows});
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(manifest), "Backup Info");
  for(const {table, rows} of contents){
    const sheetRows = rows.map(row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key,backupEncode(value)])));
    XLSX.utils.book_append_sheet(wb, sheetRows.length ? XLSX.utils.json_to_sheet(sheetRows) : XLSX.utils.aoa_to_sheet([["No records"]]), table.name);
  }
  return {wb, contents};
}
function backupWorkbookBytes(workbook){
  return XLSX.write(workbook, {bookType:"xlsx", type:"array"});
}
async function makeTableBackupWorkbook(table, rows, encryptionKey, manifest){
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(manifest), "Backup Info");
  const sheetRows = [];
  for(const row of rows){
    const output = {};
    for(const [key,value] of Object.entries(row)){
      output[key] = table.name === "user_profiles" && key === "password_display"
        ? encryptionKey ? await encryptProfilePassword(value, row.id, encryptionKey) : backupEncode(value)
        : backupEncode(value);
    }
    sheetRows.push(output);
  }
  XLSX.utils.book_append_sheet(wb, sheetRows.length ? XLSX.utils.json_to_sheet(sheetRows) : XLSX.utils.aoa_to_sheet([["No records"]]), table.name);
  return wb;
}
async function createDataBackup(){
  const btn = $("backupDownload");
  if(!state.isAdmin) return toast("Only Admin can create backups.","error");
  if(!window.XLSX) return toast("Excel library not loaded (check internet).","error");
  const passphrase = $("backupExportPass").value, confirmation = $("backupExportConfirm").value;
  if(passphrase.length < 12) return backupStatus("Enter a backup passphrase of at least 12 characters.", "error");
  if(passphrase !== confirmation) return backupStatus("Backup passphrases do not match.", "error");
  btn.disabled = true;
  try {
    const salt = backupRandom(16), encryptionKey = await deriveBackupKey(passphrase, salt);
    const {wb, contents} = await collectBackupContents(btn, encryptionKey, salt);
    XLSX.writeFile(wb, `kothari-hyundai-backup-${todayLocal()}.xlsx`);
    logAudit("CREATE_BACKUP","administration","backup",null,{tables:contents.length, records:contents.reduce((n,x) => n + x.rows.length,0)});
    toast("Excel backup downloaded.","success");
  } catch(err){ backupStatus("Backup failed: " + (err.message || err), "error"); toast("Backup failed: " + (err.message || err),"error"); }
  finally { btn.disabled = false; btn.textContent = "⬇ Download Excel Backup"; $("backupExportPass").value = ""; $("backupExportConfirm").value = ""; }
}
async function createFolderWiseBackup(){
  const btn = $("backupFolderDownload");
  if(!state.isAdmin) return toast("Only Admin can create backups.","error");
  if(!window.XLSX) return backupFolderStatus("Excel library not loaded (check internet).", "error");
  if(typeof window.showDirectoryPicker !== "function") return backupFolderStatus("Folder-wise saving requires Chrome or Edge over HTTPS. Use Download Excel Backup in this browser.", "error");
  const passphrase = $("backupExportPass").value, confirmation = $("backupExportConfirm").value;
  if(passphrase.length < 12) return backupFolderStatus("Enter a backup passphrase of at least 12 characters.", "error");
  if(passphrase !== confirmation) return backupFolderStatus("Backup passphrases do not match.", "error");
  btn.disabled = true;
  try {
    const destination = await window.showDirectoryPicker({mode:"readwrite"});
    const backupDirectory = await destination.getDirectoryHandle(`Kothari Hyundai Backup ${todayLocal()}`, {create:true});
    const salt = backupRandom(16), encryptionKey = await deriveBackupKey(passphrase, salt);
    const {wb, contents} = await collectBackupContents(btn, encryptionKey, salt);
    const masterFile = await backupDirectory.getFileHandle(`kothari-hyundai-backup-${todayLocal()}.xlsx`, {create:true});
    const masterWriter = await masterFile.createWritable();
    await masterWriter.write(backupWorkbookBytes(wb));
    await masterWriter.close();
    for(const group of Object.entries(BACKUP_FOLDER_GROUPS)){
      const [folderName, tableNames] = group;
      const folder = await backupDirectory.getDirectoryHandle(folderName, {create:true});
      for(const tableName of tableNames){
        const item = contents.find(entry => entry.table.name === tableName);
        if(!item) throw new Error(`Backup table ${tableName} is missing.`);
        const tableManifest = [
          ["Kothari Hyundai Backup", BACKUP_FORMAT],
          ["Version", BACKUP_VERSION],
          ["Created at", new Date().toISOString()],
          ["Table", "Record count"],
          ["Password field encryption", BACKUP_KDF],
          ["Encryption salt", backupBase64(salt)],
          [tableName, item.rows.length]
        ];
        const tableWorkbook = await makeTableBackupWorkbook(item.table, item.rows, encryptionKey, tableManifest);
        const fileHandle = await folder.getFileHandle(`${tableName}.xlsx`, {create:true});
        const writer = await fileHandle.createWritable();
        await writer.write(backupWorkbookBytes(tableWorkbook));
        await writer.close();
      }
    }
    logAudit("CREATE_BACKUP","administration","backup",null,{tables:contents.length, records:contents.reduce((n,x) => n + x.rows.length,0),folderWise:true});
    backupFolderStatus("Folder-wise backup saved. Upload the “Kothari Hyundai Backup” folder to Google Drive.", "success");
    toast("Folder-wise backup saved.","success");
  } catch(err){
    if(err.name === "AbortError") backupFolderStatus("Folder selection cancelled.");
    else {
      backupFolderStatus("Folder-wise backup failed: " + (err.message || err), "error");
      toast("Folder-wise backup failed: " + (err.message || err), "error");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "📁 Save Folder-wise Backup";
    $("backupExportPass").value = "";
    $("backupExportConfirm").value = "";
  }
}
async function createDriveBackup(options = {}){
  const automatic = options.automatic === true;
  const btn = $("backupDriveUpload");
  if(!state.isAdmin) return toast("Only Admin can create backups.","error");
  if(!window.XLSX) return backupDriveStatus("Excel library not loaded (check internet).", "error");
  if(DRIVE_BACKUP_RUNNING) return backupDriveStatus("A Google Drive backup is already in progress.");
  DRIVE_BACKUP_RUNNING = true;
  let backupSaved = false;
  if(btn) btn.disabled = true;
  try {
    if(automatic) toast("Automatic Google Drive backup started.","info");
    await getDriveAccessToken();
    backupDriveStatus("Connecting to Google Drive…");
    const root = await getDriveBackupRoot(true);
    if(!root) throw new Error("Could not create the Google Drive backup folder.");
    const backupDate = todayLocal();
    const backupName = `Kothari Hyundai Backup ${backupDate}`;
    const backupFolder = await getOrCreateDriveFolder(backupName, root.id);
    const {wb, contents} = await collectDriveBackupContents(btn);
    let uploaded = 0;
    for(const [folderName, tableNames] of Object.entries(BACKUP_FOLDER_GROUPS)){
      const sectionFolder = await getOrCreateDriveFolder(folderName, backupFolder.id);
      for(const tableName of tableNames){
        const item = contents.find(entry => entry.table.name === tableName);
        if(!item) throw new Error(`Backup table ${tableName} is missing.`);
        const tableManifest = [
          ["Kothari Hyundai Backup", BACKUP_FORMAT],
          ["Version", BACKUP_VERSION],
          ["Created at", new Date().toISOString()],
          ["Table", "Record count"],
          ["Password field encryption", BACKUP_PASSWORDS_OMITTED],
          ["Encryption salt", ""],
          [tableName, item.rows.length]
        ];
        const tableWorkbook = await makeTableBackupWorkbook(item.table, item.rows, null, tableManifest);
        await uploadDriveWorkbook(sectionFolder.id, `${tableName}.xlsx`, tableWorkbook);
        uploaded++;
        backupDriveStatus(`Uploading section files to Google Drive… ${uploaded}/${BACKUP_TABLES.length}`);
      }
    }
    backupDriveStatus("Uploading complete restorable workbook to Google Drive…");
    await uploadDriveWorkbook(backupFolder.id, `kothari-hyundai-backup-${backupDate}.xlsx`, wb);
    backupSaved = true;
    backupDriveStatus("Backup saved. Sending the Admin email link…");
    await emailDriveBackupLink(backupFolder, backupDate);
    logAudit("CREATE_BACKUP","administration","backup",null,{tables:contents.length, records:contents.reduce((n,x) => n + x.rows.length,0),googleDrive:true});
    backupDriveStatus(`Google Drive backup completed: ${backupName}. Use “Find Drive Backups” to validate and restore it.`, "success");
    store.set(DRIVE_AUTO_BACKUP_DATE_KEY, todayLocal());
    toast("Google Drive backup completed.","success");
    if(!automatic) await listDriveBackups();
  } catch(err){
    const message = err.message || String(err);
    const failure = backupSaved
      ? `Backup saved to Google Drive, but the Admin email could not be sent: ${message}`
      : "Google Drive backup failed: " + message;
    backupDriveStatus(failure, "error");
    toast(failure,"error");
  } finally {
    if(btn){
      btn.disabled = false;
      btn.textContent = "☁ Backup to Google Drive";
    }
    DRIVE_BACKUP_RUNNING = false;
  }
}
async function runDailyDriveBackupOnAdminLogin(){
  if(!state.isAdmin || store.get(DRIVE_AUTO_BACKUP_KEY) === "false" || DRIVE_BACKUP_RUNNING) return;
  const today = todayLocal();
  if(store.get(DRIVE_AUTO_BACKUP_DATE_KEY) === today) return;
  await createDriveBackup({automatic:true});
}
async function listDriveBackups(){
  const btn = $("backupDriveList");
  if(!state.isAdmin) return toast("Only Admin can access backup tools.","error");
  btn.disabled = true;
  $("backupDriveSelect").replaceChildren(new Option("Select a Google Drive backup",""));
  DRIVE_BACKUP_FOLDERS = new Map();
  try {
    driveRestoreStatus("Searching Google Drive backups…");
    const root = await getDriveBackupRoot(false);
    if(!root){
      driveRestoreStatus("No Kothari Hyundai backups were found in Google Drive.", "error");
      return;
    }
    const folders = await listDriveChildren(root.id, DRIVE_FOLDER_MIME);
    for(const folder of folders){
      const files = await listDriveChildren(folder.id, XLSX_MIME);
      const master = files.find(file => /^kothari-hyundai-backup-.+\.xlsx$/i.test(file.name));
      if(master) DRIVE_BACKUP_FOLDERS.set(folder.id, {folder, master});
    }
    const select = $("backupDriveSelect");
    const sorted = [...DRIVE_BACKUP_FOLDERS.values()].sort((a,b) => (b.folder.modifiedTime || "").localeCompare(a.folder.modifiedTime || ""));
    for(const item of sorted){
      const modified = item.folder.modifiedTime ? new Date(item.folder.modifiedTime).toLocaleString() : "";
      select.add(new Option(`${item.folder.name}${modified ? ` — ${modified}` : ""}`, item.folder.id));
    }
    driveRestoreStatus(sorted.length ? `${sorted.length} restorable Google Drive backup(s) found.` : "No complete Kothari Hyundai backups were found in Google Drive.", sorted.length ? "success" : "error");
  } catch(err){
    driveRestoreStatus("Could not list Google Drive backups: " + (err.message || err), "error");
  } finally {
    btn.disabled = false;
  }
}
async function loadDriveBackupForRestore(){
  if(!state.isAdmin) return toast("Only Admin can restore backups.","error");
  const backup = DRIVE_BACKUP_FOLDERS.get($("backupDriveSelect").value);
  if(!backup) return driveRestoreStatus("Find and select a complete Google Drive backup first.", "error");
  if(!window.XLSX) return driveRestoreStatus("Excel library not loaded (check internet).", "error");
  const btn = $("backupDriveLoad");
  btn.disabled = true;
  DRIVE_RESTORE_PREVIEW = null;
  DRIVE_RESTORE_FILE = null;
  $("backupDriveRestore").disabled = true;
  $("driveRestorePreview").replaceChildren();
  try {
    driveRestoreStatus(`Downloading ${backup.master.name} from Google Drive…`);
    const blob = await downloadDriveWorkbook(backup.master.id);
    const file = new File([blob], backup.master.name, {type:XLSX_MIME});
    driveRestoreStatus("Validating Google Drive backup…");
    const data = await parseBackupWorkbook(file, "");
    DRIVE_RESTORE_FILE = file;
    DRIVE_RESTORE_PREVIEW = {file, counts:data.map(x => [x.table.name, x.rows.length])};
    const total = data.reduce((n,x) => n + x.rows.length, 0);
    $("driveRestorePreview").innerHTML = `<div class="table-wrap">${table(["Table","Rows to add/update"],DRIVE_RESTORE_PREVIEW.counts)}</div><p class="form-help">${total.toLocaleString("en-IN")} rows validated from Google Drive. Current records not present in this workbook will remain unchanged.</p>`;
    driveRestoreStatus(`Google Drive backup validated: ${total.toLocaleString("en-IN")} rows ready.`, "success");
    $("backupDriveRestore").disabled = false;
  } catch(err){
    driveRestoreStatus("Google Drive backup validation failed: " + (err.message || err), "error");
  } finally {
    btn.disabled = false;
  }
}
function readBackupManifest(wb){
  const ws = wb.Sheets["Backup Info"];
  if(!ws) throw new Error("Backup Info sheet is missing.");
  const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:""});
  if(rows[0]?.[1] !== BACKUP_FORMAT || Number(rows[1]?.[1]) !== BACKUP_VERSION) throw new Error("This is not a supported Kothari Hyundai backup workbook.");
  const manifest = new Map(), metadata = new Map(rows.slice(4).filter(row => ["Password field encryption","Encryption salt"].includes(String(row[0] || ""))).map(row => [String(row[0]), String(row[1] || "")]));
  const passwordEncryption = metadata.get("Password field encryption");
  if(![BACKUP_KDF,BACKUP_PASSWORDS_OMITTED].includes(passwordEncryption)) throw new Error("Backup password encryption metadata is missing or unsupported.");
  let salt = null;
  if(passwordEncryption === BACKUP_KDF){
    if(!metadata.get("Encryption salt")) throw new Error("Backup encryption salt is missing.");
    try { salt = backupUnbase64(metadata.get("Encryption salt")); }
    catch { throw new Error("Backup encryption salt is invalid."); }
    if(salt.length !== 16) throw new Error("Backup encryption salt is invalid.");
  }
  for(const row of rows.slice(4)){
    const name = String(row[0] || "");
    if(!name || metadata.has(name)) continue;
    const count = Number(row[1]);
    if(!Number.isSafeInteger(count) || count < 0 || manifest.has(name)) throw new Error("Backup table list is invalid.");
    manifest.set(name, count);
  }
  if(manifest.size !== BACKUP_TABLES.length || BACKUP_TABLES.some(t => !manifest.has(t.name))) throw new Error("Backup is incomplete or has an unsupported table list.");
  return {manifest,salt,passwordEncryption};
}
async function readBackupTable(wb, table, expectedCount, encryptionKey, passwordEncryption){
  const ws = wb.Sheets[table.name];
  if(!ws) throw new Error(`Backup sheet ${table.name} is missing.`);
  if(Object.keys(ws).some(key => !key.startsWith("!") && ws[key]?.f)) throw new Error(`${table.name} contains Excel formulas; use an unchanged backup workbook.`);
  if(expectedCount === 0) return [];
  const rows = XLSX.utils.sheet_to_json(ws, {defval:BACKUP_NULL, raw:true});
  if(rows.length !== expectedCount) throw new Error(`${table.name} row count does not match Backup Info.`);
  const decoded = [];
  for(let index = 0; index < rows.length; index++){
    const row = rows[index];
    const out = Object.fromEntries(Object.entries(row).map(([key,value]) => [key,backupDecode(value)]));
    if(table.name === "user_profiles" && Object.hasOwn(out, "password_display")){
      if(passwordEncryption === BACKUP_PASSWORDS_OMITTED) throw new Error("This passphrase-free backup must not contain profile display-password values.");
      if(typeof out.password_display === "string" && out.password_display.startsWith(BACKUP_ENCRYPTED)) out.password_display = await decryptProfilePassword(out.password_display, out.id, encryptionKey);
    }
    if(table.key.some(key => out[key] === null || out[key] === undefined || out[key] === "")) throw new Error(`${table.name} row ${index + 2} is missing key field ${table.key.join(", ")}.`);
    decoded.push(out);
  }
  return decoded;
}
async function parseBackupWorkbook(file, passphrase){
  const wb = XLSX.read(await file.arrayBuffer(), {type:"array", cellDates:false, dense:false});
  const {manifest,salt,passwordEncryption} = readBackupManifest(wb);
  if(passwordEncryption === BACKUP_KDF && passphrase.length < 12) throw new Error("Enter the backup passphrase (at least 12 characters).");
  const encryptionKey = passwordEncryption === BACKUP_KDF ? await deriveBackupKey(passphrase, salt) : null, data = [];
  for(const table of BACKUP_TABLES) data.push({table, rows:await readBackupTable(wb, table, manifest.get(table.name), encryptionKey, passwordEncryption)});
  return data;
}
async function backupWorkbookFromFile(file){
  if(!/\.zip$/i.test(file.name)) return file;
  if(!window.JSZip) throw new Error("ZIP library did not load. Check your internet connection and reload.");
  const zip = await window.JSZip.loadAsync(file);
  const workbookPaths = Object.keys(zip.files).filter(path =>
    !zip.files[path].dir && /^kothari-hyundai-backup-.+\.xlsx$/i.test(path.split("/").pop() || "")
  );
  if(workbookPaths.length !== 1) throw new Error("ZIP must contain exactly one complete Kothari Hyundai backup workbook.");
  const workbookPath = workbookPaths[0];
  const workbookBlob = await zip.files[workbookPath].async("blob");
  return new File([workbookBlob], workbookPath.split("/").pop(), {type:XLSX_MIME});
}
async function previewDataBackup(){
  const sourceFile = $("backupFile").files?.[0];
  const btn = $("backupPreviewButton");
  RESTORE_PREVIEW = null; $("backupRestore").disabled = true; $("backupPreview").innerHTML = "";
  if(!sourceFile) return backupStatus("Select a backup ZIP or Excel workbook first.", "error");
  if(!window.XLSX) return backupStatus("Excel library not loaded (check internet).", "error");
  btn.disabled = true; backupStatus("Opening and validating backup…");
  try {
    const file = await backupWorkbookFromFile(sourceFile);
    const data = await parseBackupWorkbook(file, $("backupRestorePass").value);
    RESTORE_PREVIEW = {file, sourceFile, counts:data.map(x => [x.table.name, x.rows.length])};
    const total = data.reduce((n,x) => n + x.rows.length, 0);
    $("backupPreview").innerHTML = `<div class="table-wrap">${table(["Table","Rows to add/update"],RESTORE_PREVIEW.counts)}</div><p class="form-help">${total.toLocaleString("en-IN")} rows validated. Current records not present in this workbook will remain unchanged.</p>`;
    backupStatus(`Backup validated: ${total.toLocaleString("en-IN")} rows ready.`, "success");
    $("backupRestore").disabled = false;
  } catch(err){ backupStatus("Backup validation failed: " + (err.message || err), "error"); }
  finally { btn.disabled = false; }
}
async function restoreDataBackup(){
  return restoreBackupSource();
}
async function restoreBackupSource(){
  if(!state.isAdmin) return toast("Only Admin can restore backups.","error");
  const preview = RESTORE_PREVIEW;
  const sourceFile = $("backupFile").files?.[0];
  const status = backupStatus;
  const button = $("backupRestore");
  const passphrase = $("backupRestorePass").value;
  if(!preview || preview.sourceFile !== sourceFile) return status("Validate the selected backup before restoring.", "error");
  const total = preview.counts.reduce((n,x) => n + x[1], 0);
  if(!confirm(`Restore ${total.toLocaleString("en-IN")} rows from this backup? Matching rows will be updated; existing extra rows will not be deleted. Attachments and account passwords are not restored.`)) return;
  button.disabled = true;
  let completed = 0;
  try {
    const data = await parseBackupWorkbook(preview.file, passphrase);
    for(const {table:meta, rows} of data){
      for(let from = 0; from < rows.length; from += BACKUP_BATCH_SIZE){
        const part = rows.slice(from, from + BACKUP_BATCH_SIZE);
        status(`Restoring ${meta.name}: ${Math.min(from + part.length, rows.length)}/${rows.length}…`);
        const {error} = await state.supabase.from(meta.name).upsert(part);
        if(error) throw new Error(`${meta.name}: ${error.message}`);
        completed += part.length;
      }
    }
    const vehicles = data.find(x => x.table.name === "vehicles")?.rows || [];
    for(let from = 0; from < vehicles.length; from += BACKUP_BATCH_SIZE){
      const part = vehicles.slice(from, from + BACKUP_BATCH_SIZE);
      status(`Restoring vehicle stock state: ${Math.min(from + part.length, vehicles.length)}/${vehicles.length}…`);
      const {error} = await state.supabase.from("vehicles").upsert(part);
      if(error) throw new Error(`vehicles: ${error.message}`);
    }
    logAudit("RESTORE_BACKUP","administration","backup",null,{records:completed});
    state.locations = null; VCACHE.rows = null;
    status(`Restore completed: ${completed.toLocaleString("en-IN")} rows added or updated. No existing rows were deleted.`, "success");
    toast("Backup restore completed.","success");
    $("backupPreview").innerHTML += `<p class="message success">Restore completed. Refreshing application data…</p>`;
    RESTORE_PREVIEW = null;
    $("backupRestorePass").value = "";
    setTimeout(() => window.location.reload(), 1800);
  } catch(err){
    status(`Restore stopped after ${completed.toLocaleString("en-IN")} rows: ${err.message || err}. You can safely retry this workbook; rows are upserted.`, "error");
    toast("Restore failed: " + (err.message || err),"error");
    button.disabled = false;
  }
}
