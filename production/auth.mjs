import {createHash, randomBytes} from "node:crypto";
import {createRemoteJWKSet, jwtVerify} from "jose";
import * as oidc from "openid-client";
import {httpsUrl} from "./config.mjs";

const SESSION = "__Host-endor-session";
const LOGIN = "__Host-endor-login";
const randomToken = () => randomBytes(32).toString("base64url");
const hash = token => createHash("sha256").update(token).digest("hex");
const cookie = (name,value,seconds) => name + "=" + value + "; Path=/; Max-Age=" + seconds + "; Secure; HttpOnly; SameSite=Lax";
function cookieToken(request,name) {
  const pair = request.headers.get("Cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(name + "="));
  const value = pair?.slice(name.length + 1);
  return value && /^[a-zA-Z0-9_-]{43}$/.test(value) ? value : null;
}
function redirect(location, cookies = []) {
  const headers = new Headers({Location:location,"Cache-Control":"no-store"});
  for (const value of cookies) headers.append("Set-Cookie",value);
  return new Response(null,{status:303,headers});
}

export async function loadIdentity(config) {
  const browser = await oidc.discovery(new URL(config.issuer),config.oidcClientId,{
    client_secret:config.oidcClientSecret, token_endpoint_auth_method:"client_secret_basic",
  },oidc.ClientSecretBasic(config.oidcClientSecret));
  oidc.enableNonRepudiationChecks(browser);
  const mcpConfig = config.mcpIssuer === config.issuer ? browser :
    await oidc.discovery(new URL(config.mcpIssuer),"endor-cs-metadata");
  const jwks = createRemoteJWKSet(httpsUrl(mcpConfig.serverMetadata().jwks_uri,"MCP JWKS endpoint"));
  return {
    start({state,nonce,challenge}) {
      return oidc.buildAuthorizationUrl(browser,{redirect_uri:config.origin + "/oidc/callback",
        scope:"openid",response_type:"code",state,nonce,code_challenge:challenge,code_challenge_method:"S256"}).href;
    },
    async finish(url,attempt) {
      const tokens = await oidc.authorizationCodeGrant(browser,url,{
        expectedState:attempt.state,expectedNonce:attempt.nonce,pkceCodeVerifier:attempt.verifier,
      });
      return tokens.claims()?.sub;
    },
    async verify(token) {
      return verifyMcpToken(token,jwks,config);
    },
  };
}

export async function verifyMcpToken(token, jwks, config) {
  const {payload} = await jwtVerify(token,jwks,{issuer:config.mcpIssuer,audience:config.resource,
    algorithms:["RS256"],requiredClaims:["exp","sub"]});
  const scopes = Array.isArray(payload.scp) ? payload.scp : (typeof payload.scope === "string" ? payload.scope.split(/\s+/) : []);
  if (!scopes.includes(config.scope)) return {error:"insufficient_scope"};
  const userId = payload[config.subjectClaim];
  return typeof userId === "string" && userId.trim() && userId.length <= 300 ? {userId} : {error:"invalid_token"};
}

export function createAuth(pool, config, identity) {
  return {
    async browserUser(request) {
      const token = cookieToken(request,SESSION);
      if (!token) return null;
      const {rows:[session]} = await pool.query("SELECT user_id FROM cs_pilot.web_session WHERE token_hash = $1 AND expires_at > now()",[hash(token)]);
      return session?.user_id ?? null;
    },
    async login() {
      const token = randomToken();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      await pool.query("DELETE FROM cs_pilot.login_attempt WHERE expires_at <= now()");
      await pool.query(`INSERT INTO cs_pilot.login_attempt (token_hash,state,nonce,verifier,expires_at)
        VALUES ($1,$2,$3,$4,now() + interval '5 minutes')`,[hash(token),state,nonce,verifier]);
      const url = identity.start({state,nonce,challenge:await oidc.calculatePKCECodeChallenge(verifier)});
      return redirect(url,[cookie(LOGIN,token,300)]);
    },
    async callback(request) {
      const token = cookieToken(request,LOGIN);
      if (!token) return redirect("/?login=failed");
      const {rows:[attempt]} = await pool.query(`DELETE FROM cs_pilot.login_attempt
        WHERE token_hash=$1 AND expires_at > now() RETURNING state,nonce,verifier`,[hash(token)]);
      const expired = cookie(LOGIN,"",0);
      if (!attempt) return redirect("/?login=failed",[expired]);
      let userId;
      try { userId = await identity.finish(new URL(request.url),attempt); }
      catch { return redirect("/?login=failed",[expired]); }
      if (typeof userId !== "string" || !userId.trim() || userId.length > 300) return redirect("/?login=failed",[expired]);
      const session = randomToken();
      await pool.query("DELETE FROM cs_pilot.web_session WHERE expires_at <= now()");
      const previous = cookieToken(request,SESSION);
      if (previous) await pool.query("DELETE FROM cs_pilot.web_session WHERE token_hash=$1",[hash(previous)]);
      await pool.query(`INSERT INTO cs_pilot.web_session (token_hash,user_id,expires_at)
        VALUES ($1,$2,now() + interval '8 hours')`,[hash(session),userId]);
      return redirect("/",[expired,cookie(SESSION,session,28800)]);
    },
    async logout(request) {
      const token = cookieToken(request,SESSION);
      if (token) await pool.query("DELETE FROM cs_pilot.web_session WHERE token_hash=$1",[hash(token)]);
      return redirect("/",[cookie(SESSION,"",0)]);
    },
    async mcpUser(request) {
      const token = request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (!token) return {error:"missing_token"};
      try { return await identity.verify(token); } catch { return {error:"invalid_token"}; }
    },
  };
}
