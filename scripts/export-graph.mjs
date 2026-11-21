import {mkdir, readFile, writeFile} from "node:fs/promises";
import {openCanonicalDatabase} from "../src/sqlite.mjs";
import {createService} from "../src/service.mjs";

const root = new URL("../",import.meta.url);
const read = path => readFile(new URL(path,root),"utf-8");
const ontology = JSON.parse(await read("docs/ontology.json"));
const db = openCanonicalDatabase();
const service = createService(db,ontology);
const {snapshot,accounts} = await service.listAccounts();
const graphs = Object.fromEntries(await Promise.all(accounts.map(async item => [
  item.account_id,Object.fromEntries(await Promise.all(["relationships","evidence","actions","expansion_research"].map(async mode => [
    mode,await service.getKnowledgeGraph({account:item.account_id,mode}),
  ]))),
])));
const outreach_previews = {};
for (const [id, graph] of Object.entries(graphs)) {
  outreach_previews[id] = Object.fromEntries(await Promise.all(graph.expansion_research.nodes.filter(node => node.outreach_scope).map(async node => {
    const {subject,body,recipient,route} = await service.draftExpansionOutreach({
      account:id,buying_group:node.outreach_scope.buying_group_id,person:node.outreach_scope.person_id,
    });
    return [node.id,{subject,body,recipient,route}];
  })));
}
const csvDir = new URL("data/csv/",root);
await mkdir(csvDir,{recursive:true});
const exports = {};
const quote = value => '"' + String(value ?? "").replaceAll('"','""') + '"';
for (const [name,info] of Object.entries(ontology.datasets)) {
  const rows = db.all(`SELECT * FROM ${name} ORDER BY ${info.order_by}`);
  const columns = db.all(`PRAGMA table_info(${name})`).map(item => item.name);
  exports[name] = {columns, rows};
  const body = [columns.map(quote).join(","),...rows.map(row => columns.map(column => quote(row[column])).join(","))].join("\r\n");
  await writeFile(new URL(name + ".csv",csvDir),body + "\r\n");
}
const event_details = Object.fromEntries(await Promise.all(exports.v_engagement_timeline.rows.map(async ({event_id}) => [
  event_id,await service.getEvent({event_id}),
])));
db.close();
const console_url = process.env.ENDOR_CS_CONSOLE_URL || "http://127.0.0.1:8080";
const graphData = JSON.stringify({snapshot,accounts,ontology,graphs,datasets:exports,outreach_previews,event_details,console_url}).replaceAll("<","\\u003c");
const [shell,style,graph,outreach,timeline] = await Promise.all(
  ["shell.html","style.css","graph.js","outreach.js","timeline.js"].map(file => read("visual/" + file)),
);
const script = [graph,outreach,timeline,"render();"].join("\n");
const page = shell.replace("<!-- STYLE -->",() => style).replace("<!-- DATA -->",() => graphData).replace("<!-- SCRIPT -->",() => script);
await writeFile(new URL("visual/Endor_CS_Knowledge_Graph.html",root),page);
console.log("Exported " + Object.keys(exports).length + " datasets and graph for " + accounts.length + " accounts.");
