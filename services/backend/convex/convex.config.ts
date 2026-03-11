import resend from "@convex-dev/resend/convex.config.js";
import durableAgents from "@tokenspace/convex-durable-agents/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(durableAgents);
app.use(resend);

export default app;
