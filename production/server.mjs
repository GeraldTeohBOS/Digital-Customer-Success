import pg from "pg";
import {required,webConfig} from "./config.mjs";
import {loadIdentity} from "./auth.mjs";
import {createApp} from "./app.mjs";
import {configureGong} from "./gong.mjs";
import {listen} from "./http.mjs";

const config = webConfig();
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
const pool = new pg.Pool({
  connectionString:required(process.env,"DATABASE_URL"), max:10, connectionTimeoutMillis:5000, statement_timeout:12000,
});
pool.on("error",error => console.error("Idle database connection closed:",error.code || error.name));
const gong = configureGong();
const app = await createApp(pool,config,await loadIdentity(config),gong);
const server = listen(app,{origin:config.origin,port,host:"0.0.0.0"});
server.once("listening",() => console.log("CS pilot started on port " + port + "."));
for (const event of ["SIGINT","SIGTERM"]) process.once(event,() => server.close(() => pool.end()));
