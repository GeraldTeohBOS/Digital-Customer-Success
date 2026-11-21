export function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(name + " is required.");
  return value;
}

export function httpsUrl(value, name, {originOnly = false} = {}) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
      (originOnly && url.pathname !== "/")) {
    throw new Error(name + " must be an HTTPS URL without credentials, query or fragment.");
  }
  return url;
}

export function webConfig(env = process.env) {
  const origin = httpsUrl(required(env,"PUBLIC_URL"),"PUBLIC_URL",{originOnly:true}).origin;
  const issuer = httpsUrl(required(env,"OIDC_ISSUER"),"OIDC_ISSUER").href.replace(/\/$/,"");
  const mcpIssuer = httpsUrl(env.MCP_ISSUER?.trim() || issuer,"MCP_ISSUER").href.replace(/\/$/,"");
  const path = "/.well-known/oauth-protected-resource/mcp";
  return {
    origin, issuer, mcpIssuer, resource:origin + "/mcp", metadataUrl:origin + path, metadataPath:path,
    oidcClientId:required(env,"OIDC_CLIENT_ID"),
    oidcClientSecret:required(env,"OIDC_CLIENT_SECRET"),
    subjectClaim:env.MCP_USER_ID_CLAIM?.trim() || "uid",
    scope:"cs.read",
    allowedOrigins:[origin,"https://chatgpt.com","https://claude.ai"],
  };
}
