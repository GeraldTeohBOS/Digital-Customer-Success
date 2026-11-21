export function emailBodyHtml(body) {
  const entities = {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};
  const escaped = body.replace(/[&<>"']/g,character => entities[character]).replace(/\r\n/g,"\n");
  return escaped.split(/\n{2,}/).map(paragraph => "<p>" + paragraph.replaceAll("\n","<br>") + "</p>").join("");
}
