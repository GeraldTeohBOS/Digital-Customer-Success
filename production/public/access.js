const accessPanel = document.querySelector("#access-panel");
const accessAccount = document.querySelector("#access-account");
const accessRole = document.querySelector("#access-role");
const accessUser = document.querySelector("#access-user");
const accessForm = document.querySelector("#access-form");
const accessNotice = document.querySelector("#access-notice");
const accessRecords = document.querySelector("#access-records");
let accessVersion = 0;

async function accessRequest(account,change) {
  const url = account ? "/api/access?" + new URLSearchParams({account_id:account}) : "/api/access";
  const response = await fetch(url,change ? {
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(change),
  } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Account access could not be loaded.");
  return result;
}

function accessTable(title,headings,rows) {
  const cells = (tag,values) => values.map(value => "<"+tag+">"+esc(value)+"</"+tag+">").join("");
  return "<h3>" + title + '</h3><div class="panel table-scroll"><table><thead><tr>' +
    cells("th",headings) + "</tr></thead><tbody>" + rows.map(row=>"<tr>"+cells("td",row)+"</tr>").join("") + "</tbody></table></div>";
}

async function loadAccessRecords() {
  const version = ++accessVersion;
  const account = accessAccount.value;
  accessRecords.replaceChildren();
  try {
    const {grants,audit} = await accessRequest(account);
    if (version !== accessVersion) return;
    accessRecords.innerHTML = accessTable("Current grants",["User identity ID","Role","Granted"],grants.map(row =>
      [row.user_id,row.role,display(row.granted_at)])) +
      accessTable("Recent audit events",["Time","Actor","Action","Target"],audit.map(row =>
        [display(row.recorded_at),row.actor_id,row.action,row.target_user_id ?
          row.target_user_id + " · " + row.target_role : row.draft_id + " · Revision " + row.revision]));
  } catch (error) {
    if (version === accessVersion) accessNotice.textContent = error.message;
  }
}

async function findManagedAccounts() {
  try {
    const {accounts,roles} = await accessRequest();
    accessPanel.hidden = !accounts.length;
    if (!accounts.length) {
      ++accessVersion;
      accessRecords.replaceChildren();
      return;
    }
    const previous = accessAccount.value;
    accessAccount.innerHTML = accounts.map(row =>
      '<option value="' + esc(row.account_id) + '">' + esc(row.account_id) + '</option>').join("");
    if (accounts.some(row => row.account_id === previous)) accessAccount.value = previous;
    accessRole.innerHTML = roles.map(role =>
      '<option value="' + esc(role.id) + '">' + esc(role.label) + '</option>').join("");
    await loadAccessRecords();
  } catch (error) {
    accessNotice.textContent = error.message;
  }
}

accessAccount.addEventListener("change",() => {
  accessNotice.textContent = "";
  loadAccessRecords();
});
document.querySelector("#access-refresh").addEventListener("click",findManagedAccounts);
accessForm.addEventListener("submit",async event => {
  event.preventDefault();
  const operation = event.submitter.value;
  const change = {operation,account_id:accessAccount.value,user_id:accessUser.value,role:accessRole.value};
  const controls = [...accessForm.elements];
  controls.forEach(control=>{control.disabled = true;});
  try {
    const {changed} = await accessRequest(null,change);
    accessNotice.textContent = changed ? (operation === "grant" ? "Role granted." : "Role revoked.") : "No role change was needed.";
    await loadAccessRecords();
  } catch (error) {
    accessNotice.textContent = error.message;
  } finally {
    controls.forEach(control=>{control.disabled = false;});
  }
});
findManagedAccounts();
